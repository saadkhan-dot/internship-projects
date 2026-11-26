<?php
/**
 * Background Worker - Modular Version
 * Orchestrates: sitemap_helper.php and checker_helper.php
 */

require_once __DIR__ . '/includes/storage_helper.php';
require_once __DIR__ . '/includes/sitemap_helper.php';
require_once __DIR__ . '/includes/checker_helper.php';

// Set up error logging
ini_set('display_errors', 0);
ini_set('log_errors', 1);
error_reporting(E_ALL);

// Set execution limits for long-running scans
set_time_limit(0);
ini_set('memory_limit', '512M');

// Configuration
if (!defined('DATA_DIR')) define('DATA_DIR', __DIR__ . '/data');
if (!defined('PROJECTS_DIR')) define('PROJECTS_DIR', DATA_DIR . '/projects');
if (!defined('LOGS_DIR')) define('LOGS_DIR', DATA_DIR . '/logs');
if (!defined('SITEMAPS_DIR')) define('SITEMAPS_DIR', DATA_DIR . '/sitemaps');
if (!defined('LOCK_DIR')) define('LOCK_DIR', DATA_DIR . '/locks');

// Ensure directories exist
foreach ([DATA_DIR, PROJECTS_DIR, LOGS_DIR, SITEMAPS_DIR, LOCK_DIR] as $dir) {
    if (!file_exists($dir)) @mkdir($dir, 0755, true);
}

// Get and strictly validate project ID
$projectId = $argv[1] ?? null;

if (!$projectId || !isValidProjectId($projectId)) {
    @file_put_contents(
        LOGS_DIR . '/worker_error.log',
        "[" . date('Y-m-d H:i:s') . "] Error: Missing or invalid project ID provided\n",
        FILE_APPEND | LOCK_EX
    );
    exit(1);
}

// Acquire dedicated worker execution lock for the entire worker lifecycle.
$workerLock = acquireWorkerLock($projectId);
if (!$workerLock['ok']) {
    $reason = !empty($workerLock['busy'])
        ? 'Another worker already owns this project'
        : ($workerLock['error'] ?? 'Failed to acquire worker lock');
    @file_put_contents(
        LOGS_DIR . '/worker_error.log',
        "[" . date('Y-m-d H:i:s') . "] Skipping worker for {$projectId}: {$reason}\n",
        FILE_APPEND | LOCK_EX
    );
    exit(0);
}

$GLOBALS['_active_worker_lock'] = $workerLock;
$GLOBALS['_last_heartbeat_at'] = 0;
$GLOBALS['_in_heartbeat'] = false;

register_shutdown_function(function () {
    if (isset($GLOBALS['_active_worker_lock'])) {
        releaseWorkerLock($GLOBALS['_active_worker_lock']);
    }
});

$projectRes = loadProjectResult($projectId);
if (!$projectRes['ok']) {
    if ($projectRes['status'] === 'missing') {
        @file_put_contents(
            LOGS_DIR . '/worker_error.log',
            "[" . date('Y-m-d H:i:s') . "] Project missing (deleted or uninitialized): {$projectId}\n",
            FILE_APPEND | LOCK_EX
        );
        releaseWorkerLock($GLOBALS['_active_worker_lock']);
        exit(0);
    }
    logMessage($projectId, 'ERROR', "Failed to load project {$projectId}: " . ($projectRes['error'] ?? 'Unknown error'));
    releaseWorkerLock($GLOBALS['_active_worker_lock']);
    exit(1);
}
$project = $projectRes['data'];

if (in_array($project['status'] ?? null, ['completed', 'failed', 'deleted'], true)) {
    releaseWorkerLock($GLOBALS['_active_worker_lock']);
    exit(0);
}

logMessage($projectId, 'INFO', '=== WORKER STARTED ===');
maybeUpdateHeartbeat($projectId, true);

try {
    // --- STEP 1: URL DISCOVERY ---
    updateProjectStatus($projectId, 'detecting_sitemap');
    $urls = [];

    // Shared responsive pause/abort check callback for crawler and retry backoffs.
    $workerShouldAbort = function () use ($projectId) {
        while (true) {
            $currentRes = loadProjectResult($projectId);
            if (!$currentRes['ok']) {
                if ($currentRes['status'] === 'missing') {
                    return 'abort';
                }
                return 'abort';
            }
            $currentProject = $currentRes['data'];
            if (($currentProject['status'] ?? null) === 'paused') {
                maybeUpdateHeartbeat($projectId, false);
                sleep(2);
                continue;
            }
            if (in_array($currentProject['status'] ?? null, ['failed', 'deleted'], true)) {
                return 'abort';
            }
            return 'ok';
        }
    };

    // Attempt unified URL discovery (custom/direct sitemap, robots.txt, common paths,
    // recursive/gzip sitemaps, supplementary RSS/Atom feeds, and crawl fallback).
    logMessage($projectId, 'INFO', "Searching for sitemaps and website URLs...");
    $discovery = discoverWebsiteUrls($projectId, $project['website_url'], [
        'sitemap_url' => $project['sitemap_url'] ?? null,
        'use_sitemap' => $project['use_sitemap'] ?? true,
        'should_abort' => $workerShouldAbort,
        'on_crawl_start' => function () use ($projectId) {
            updateProjectStatus($projectId, 'generating_sitemap');
        },
    ]);
    $urls = $discovery['urls'];

    if (!empty($discovery['sitemap_used'])) {
        logMessage($projectId, 'SUCCESS', "Discovered " . count($urls) . " URLs via sitemap" . (!empty($discovery['sources']['feeds']) ? " and feeds" : ""));
        updateProjectData($projectId, ['sitemap_used' => true]);
    }

    if (!empty($discovery['sitemap_generated']) && !empty($urls)) {
        logMessage($projectId, 'SUCCESS', "Generated sitemap with " . count($urls) . " URLs via crawling");

        // Save as standard XML sitemap
        $sitemapFile = projectSitemapPath($projectId);
        if (saveAsStandardSitemap($urls, $sitemapFile)) {
            logMessage($projectId, 'INFO', "Standard sitemap saved to: " . basename($sitemapFile));
            updateProjectData($projectId, ['sitemap_generated' => true, 'output_sitemap' => basename($sitemapFile)]);
        }
    }

    // Canonicalize and deduplicate discovery results before persistence and scanning.
    $canonicalBaseUrl = !empty($discovery['canonical_url']) ? $discovery['canonical_url'] : $project['website_url'];
    $urls = normalizeAndDeduplicateUrls($urls, $canonicalBaseUrl);

    if (empty($urls)) {
        throw new Exception("Could not find or generate any URLs for this website.");
    }

    // Abort cleanly if project was deleted/failed during discovery before writing _urls.json
    abortIfProjectStopped($projectId);

    // Save discovered URLs for reference
    $urlsFile = SITEMAPS_DIR . '/' . $projectId . '_urls.json';
    if (!storageWriteJson($urlsFile, $urls, '', JSON_PRETTY_PRINT, projectStorageLogger($projectId))) {
        logMessage($projectId, 'WARNING', 'Failed to write discovered URLs file');
    }
    
    // --- STEP 2: BOUNDED CONCURRENT CHECKING ---
    updateProjectStatus($projectId, 'checking');
    $cfg = loadDiscoveryConfig();
    logMessage(
        $projectId,
        'INFO',
        "Starting concurrent check (concurrency={$cfg['concurrency']}, per_host={$cfg['per_host_concurrency']}) for 'Lorem Ipsum' placeholder text..."
    );

    $total = count($urls);
    $counters = [
        'clean' => 0,
        'lorem_found' => 0,
        'errors' => 0,
        'cf_blocked' => 0,
        'js_rendered' => 0,
        'skipped' => 0,
    ];
    $resultsByUrl = [];
    $lastProgressFlushAt = 0.0;
    $pendingProgressCount = 0;

    $buildProgressPayload = function ($stats) use ($total, &$counters) {
        $completed = (int)($stats['completed_urls'] ?? 0);
        return [
            'total_urls'      => $total,
            'processed'       => $completed,
            'completed'       => $completed,
            'active_requests' => (int)($stats['active_requests'] ?? 0),
            'retry_attempts'  => (int)($stats['retry_attempts'] ?? 0),
            'clean'           => $counters['clean'],
            'lorem_found'     => $counters['lorem_found'],
            'errors'          => $counters['errors'],
            'failed'          => $counters['errors'],
            'skipped'         => $counters['skipped'],
            'cf_blocked'      => $counters['cf_blocked'],
            'js_rendered'     => $counters['js_rendered'],
            'percentage'      => $total > 0 ? round(($completed / $total) * 100, 2) : 0,
        ];
    };

    $lastLifecyclePoll = 0.0;
    $cachedLifecycle = 'ok';
    $workerLifecycleCheck = function () use ($projectId, &$lastLifecyclePoll, &$cachedLifecycle) {
        $now = microtime(true);
        if (($now - $lastLifecyclePoll) < 0.25) {
            return $cachedLifecycle;
        }
        $lastLifecyclePoll = $now;
        $currentRes = loadProjectResult($projectId);
        if (!$currentRes['ok']) {
            $cachedLifecycle = 'abort';
            return 'abort';
        }
        $status = $currentRes['data']['status'] ?? null;
        if ($status === 'paused') {
            $cachedLifecycle = 'paused';
            return 'paused';
        }
        if (in_array($status, ['failed', 'deleted'], true)) {
            $cachedLifecycle = 'abort';
            return 'abort';
        }
        $cachedLifecycle = 'ok';
        return 'ok';
    };

    $onPauseWait = function ($stats) use (
        $projectId,
        $buildProgressPayload,
        &$lastProgressFlushAt,
        &$pendingProgressCount,
        &$lastLifecyclePoll
    ) {
        updateProjectData($projectId, ['progress' => $buildProgressPayload($stats)]);
        $lastProgressFlushAt = microtime(true);
        $pendingProgressCount = 0;

        while (true) {
            $currentRes = loadProjectResult($projectId);
            if (!$currentRes['ok']) {
                return 'abort';
            }
            $st = $currentRes['data']['status'] ?? null;
            if ($st === 'paused') {
                maybeUpdateHeartbeat($projectId, false);
                sleep(2);
                continue;
            }
            if (in_array($st, ['failed', 'deleted'], true)) {
                return 'abort';
            }
            $lastLifecyclePoll = 0.0; // force fresh lifecycle check on resume
            return 'resume';
        }
    };

    $concurrentRes = fetchPagesConcurrent($urls, [
        'config' => $cfg,
        'lifecycle_check' => $workerLifecycleCheck,
        'on_pause_wait' => $onPauseWait,
        'on_result' => function ($url, $fetchResult, $stats) use (
            $projectId,
            $total,
            &$counters,
            &$resultsByUrl,
            &$lastProgressFlushAt,
            &$pendingProgressCount,
            $buildProgressPayload
        ) {
            $resultsByUrl[$url] = buildCheckedPageEntry($projectId, $url, $fetchResult, $counters);
            $pendingProgressCount++;

            $now = microtime(true);
            $completed = (int)($stats['completed_urls'] ?? 0);
            if ($pendingProgressCount >= 3 || ($now - $lastProgressFlushAt) >= 1.0 || $completed >= $total) {
                updateProjectData($projectId, ['progress' => $buildProgressPayload($stats)]);
                $lastProgressFlushAt = $now;
                $pendingProgressCount = 0;
            }
        },
    ]);

    if (!empty($concurrentRes['aborted'])) {
        exit(0);
    }

    $results = [];
    foreach ($urls as $u) {
        if (isset($resultsByUrl[$u])) {
            $results[] = $resultsByUrl[$u];
        }
    }

    $finalStats = $concurrentRes['stats'];
    $processed = (int)($finalStats['completed_urls'] ?? count($results));
    $clean = $counters['clean'];
    $loremFound = $counters['lorem_found'];
    $errors = $counters['errors'];
    $cfBlocked = $counters['cf_blocked'];
    $jsRendered = $counters['js_rendered'];
    $skipped = $counters['skipped'];
    $retryAttempts = (int)($finalStats['retry_attempts'] ?? 0);

    // --- STEP 3: WRAP UP ---
    abortIfProjectStopped($projectId);
    updateProjectData($projectId, [
        'progress' => [
            'total_urls'      => $total,
            'processed'       => $processed,
            'completed'       => $processed,
            'active_requests' => 0,
            'retry_attempts'  => $retryAttempts,
            'clean'           => $clean,
            'lorem_found'     => $loremFound,
            'errors'          => $errors,
            'failed'          => $errors,
            'skipped'         => $skipped,
            'cf_blocked'      => $cfBlocked,
            'js_rendered'     => $jsRendered,
            'percentage'      => 100
        ],
        'results' => $results,
        'completed_at' => date('Y-m-d H:i:s')
    ]);
    updateProjectStatus($projectId, 'completed');
    logMessage($projectId, 'SUCCESS', "All checks completed. Processed: {$processed}, Clean: {$clean}, Lorem Found: {$loremFound}, CF Blocked: {$cfBlocked}, JS Rendered: {$jsRendered}, Skipped: {$skipped}, Retries: {$retryAttempts}, Errors: {$errors}");

} catch (Exception $e) {
    logMessage($projectId, 'ERROR', "Worker failed: " . $e->getMessage());
    updateProjectStatus($projectId, 'failed');
    updateProjectData($projectId, ['error' => $e->getMessage()]);
} finally {
    if (isset($GLOBALS['_active_worker_lock'])) {
        releaseWorkerLock($GLOBALS['_active_worker_lock']);
    }
}

// --- HELPERS ---

function buildCheckedPageEntry($projectId, $url, array $fetchResult, array &$counters) {
    $checkData = [
        'url' => $url,
        'status' => 'pending',
        'details' => '',
        'checked_at' => date('Y-m-d H:i:s')
    ];

    if (isset($fetchResult['error'])) {
        $errorType = $fetchResult['error_type'] ?? 'http_error';

        if ($errorType === 'cloudflare_blocked') {
            $checkData['status']  = 'cloudflare_blocked';
            $checkData['details'] = $fetchResult['error'];
            $counters['cf_blocked']++;
            logMessage($projectId, 'WARNING', "⚠ CLOUDFLARE PROTECTION on: {$url} — " . $fetchResult['error']);
        } elseif ($errorType === 'rate_limited') {
            $checkData['status']  = 'error';
            $checkData['details'] = 'RATE LIMITED - ' . $fetchResult['error'];
            $counters['errors']++;
            logMessage($projectId, 'WARNING', "Rate limited on: {$url}");
        } elseif ($errorType === 'ip_banned') {
            $checkData['status']  = 'error';
            $checkData['details'] = 'IP BANNED - ' . $fetchResult['error'];
            $counters['errors']++;
            logMessage($projectId, 'ERROR', "IP ban detected on: {$url}");
        } elseif ($errorType === 'timeout') {
            $checkData['status']  = 'error';
            $checkData['details'] = 'TIMEOUT - ' . $fetchResult['error'];
            $counters['errors']++;
            logMessage($projectId, 'WARNING', "Timeout on: {$url}");
        } else {
            $checkData['status']  = 'error';
            $checkData['details'] = $fetchResult['error'];
            $counters['errors']++;
        }
    } elseif (!empty($fetchResult['skipped'])) {
        $checkData['status'] = 'skipped';
        $checkData['details'] = $fetchResult['skip_reason'] ?? 'Skipped non-HTML content';
        $counters['skipped']++;
        logMessage($projectId, 'INFO', "Skipped non-HTML content on: {$url}");
    } elseif (!empty($fetchResult['js_shell'])) {
        $checkData['status'] = 'js_rendered';
        $checkData['details'] = 'JS-RENDERED / EMPTY SHELL - ' . ($fetchResult['js_shell_reason'] ?? 'Requires JavaScript rendering');
        $counters['js_rendered']++;
        logMessage($projectId, 'WARNING', "JS-rendered shell detected on: {$url}");
    } else {
        $loremData = detectLoremIpsum($fetchResult['content'], $url);
        if ($loremData['found']) {
            $checkData['status'] = 'lorem_found';
            $checkData['details'] = $loremData['details'];
            $checkData['occurrences'] = $loremData['count'];
            if (!empty($loremData['page_title'])) {
                $checkData['page_title'] = $loremData['page_title'];
            }
            $checkData['findings'] = $loremData['findings'];
            $checkData['findings_count'] = count($loremData['findings']);
            if (!empty($loremData['findings_truncated'])) {
                $checkData['findings_truncated'] = true;
            }
            $counters['lorem_found']++;
            logMessage($projectId, 'WARNING', "Lorem Ipsum found on: {$url}");
        } else {
            $checkData['status'] = 'clean';
            $checkData['details'] = 'Clean - No placeholder text found';
            $counters['clean']++;
        }
    }

    return $checkData;
}

function abortIfProjectStopped($projectId) {
    $res = loadProjectResult($projectId);
    if (!$res['ok']) {
        if ($res['status'] === 'missing') {
            exit(0);
        }
        return;
    }
    if (in_array($res['data']['status'] ?? null, ['failed', 'deleted'], true)) {
        exit(0);
    }
}

function maybeUpdateHeartbeat($projectId, $force = false) {
    if (!empty($GLOBALS['_in_heartbeat'])) {
        return;
    }
    $now = time();
    if (!$force && ($now - ($GLOBALS['_last_heartbeat_at'] ?? 0)) < WORKER_HEARTBEAT_INTERVAL) {
        return;
    }

    $GLOBALS['_in_heartbeat'] = true;
    try {
        $res = updateWorkerHeartbeat($projectId, date('Y-m-d H:i:s', $now), getmypid());
        if ($res['ok']) {
            $GLOBALS['_last_heartbeat_at'] = $now;
        } elseif (in_array($res['status'] ?? null, ['missing', 'invalid_id'], true)) {
            exit(0);
        }
    } finally {
        $GLOBALS['_in_heartbeat'] = false;
    }
}

function updateProjectStatus($projectId, $status) {
    $now = time();
    $includeHeartbeat = ($now - ($GLOBALS['_last_heartbeat_at'] ?? 0)) >= WORKER_HEARTBEAT_INTERVAL;
    $res = updateProject($projectId, function ($project) use ($status, $now, $includeHeartbeat) {
        if (in_array($project['status'] ?? null, ['deleted'], true)) {
            return null;
        }
        $nowStr = date('Y-m-d H:i:s', $now);
        $project['status'] = $status;
        $project['updated_at'] = $nowStr;
        if ($includeHeartbeat) {
            $project['heartbeat_at'] = $nowStr;
            $project['worker_pid'] = getmypid();
        }
        return $project;
    });
    if ($res['ok'] && !empty($res['changed'])) {
        if ($includeHeartbeat) {
            $GLOBALS['_last_heartbeat_at'] = $now;
        }
        logMessage($projectId, 'INFO', "Status changed to: {$status}");
    } elseif (!$res['ok'] && ($res['status'] ?? null) === 'missing') {
        exit(0);
    }
}

function updateProjectData($projectId, $data) {
    $now = time();
    $includeHeartbeat = ($now - ($GLOBALS['_last_heartbeat_at'] ?? 0)) >= WORKER_HEARTBEAT_INTERVAL;
    $res = updateProject($projectId, function ($project) use ($data, $now, $includeHeartbeat) {
        if (in_array($project['status'] ?? null, ['deleted'], true)) {
            return null;
        }
        $nowStr = date('Y-m-d H:i:s', $now);
        $project = array_merge_recursive_custom($project, $data);
        $project['updated_at'] = $nowStr;
        if ($includeHeartbeat) {
            $project['heartbeat_at'] = $nowStr;
            $project['worker_pid'] = getmypid();
        }
        return $project;
    });
    if ($res['ok'] && !empty($res['changed']) && $includeHeartbeat) {
        $GLOBALS['_last_heartbeat_at'] = $now;
    } elseif (!$res['ok'] && ($res['status'] ?? null) === 'missing') {
        exit(0);
    }
    return $res;
}

function array_merge_recursive_custom($array1, $array2) {
    foreach ($array2 as $key => $value) {
        if (is_array($value) && isset($array1[$key]) && is_array($array1[$key])) {
            $array1[$key] = array_merge($array1[$key], $value);
        } else {
            $array1[$key] = $value;
        }
    }
    return $array1;
}

function logMessage($projectId, $level, $message) {
    if (!isValidProjectId($projectId)) {
        return;
    }
    $timestamp = date('Y-m-d H:i:s');
    $logEntry = "[{$timestamp}] [{$level}] {$message}\n";
    @file_put_contents(projectLogPath($projectId), $logEntry, FILE_APPEND | LOCK_EX);
    echo $logEntry;

    if (empty($GLOBALS['_in_heartbeat']) && $level !== 'ERROR') {
        maybeUpdateHeartbeat($projectId, false);
    }
}
