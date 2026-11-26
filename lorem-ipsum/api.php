<?php
/**
 * Lorem Ipsum Checker API - Fixed Version with Debugging
 * Non-blocking API with support for multiple concurrent projects
 */

// Error handling - catch all errors before headers
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

// Start output buffering to catch any errors
ob_start();

try {
    // Configuration
    if (!defined('DATA_DIR')) define('DATA_DIR', __DIR__ . '/data');
    if (!defined('PROJECTS_DIR')) define('PROJECTS_DIR', DATA_DIR . '/projects');
    if (!defined('LOGS_DIR')) define('LOGS_DIR', DATA_DIR . '/logs');
    if (!defined('SITEMAPS_DIR')) define('SITEMAPS_DIR', DATA_DIR . '/sitemaps');
    if (!defined('LOCK_DIR')) define('LOCK_DIR', DATA_DIR . '/locks');

    // Initialize directories
    foreach ([DATA_DIR, PROJECTS_DIR, LOGS_DIR, SITEMAPS_DIR, LOCK_DIR] as $dir) {
        if (!file_exists($dir)) {
            @mkdir($dir, 0755, true);
        }
    }

    // Load configuration (make it optional)
    $config = [];
    if (file_exists(__DIR__ . '/config.php')) {
        $config = @include __DIR__ . '/config.php';
        if (!is_array($config)) {
            $config = [];
        }
    }

    require_once __DIR__ . '/includes/storage_helper.php';
    require_once __DIR__ . '/includes/sitemap_helper.php';

    // Clean output buffer
    ob_end_clean();

    // Now set headers
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, DELETE');
    header('Access-Control-Allow-Headers: Content-Type');

    // Handle preflight requests
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        exit(0);
    }

    // Route the request
    $action = $_GET['action'] ?? $_POST['action'] ?? 'list';

    switch ($action) {
        case 'start':
            handleStart();
            break;
        case 'status':
            handleStatus();
            break;
        case 'list':
            handleList();
            break;
        case 'delete':
            handleDelete();
            break;
        case 'pause':
            handlePause();
            break;
        case 'resume':
            handleResume();
            break;
        case 'export':
            handleExport();
            break;
        case 'download_sitemap':
            handleDownloadSitemap();
            break;
        case 'logs':
            handleLogs();
            break;
        default:
            respondError('Invalid action', 400);
    }
} catch (Exception $e) {
    // Clean any output
    if (ob_get_level()) ob_end_clean();
    
    // Send JSON error
    header('Content-Type: application/json');
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage()
    ]);
    exit;
}

/**
 * Start a new Lorem Ipsum check (non-blocking)
 */
function handleStart() {
    $projectName = $_POST['project_name'] ?? '';
    $websiteUrl = $_POST['website_url'] ?? null;
    $useSitemap = ($_POST['use_sitemap'] ?? 'auto') === 'auto';
    $sitemapUrl = $_POST['sitemap_url'] ?? null;
    $requestedProjectId = $_POST['project_id'] ?? null;
    if ($requestedProjectId === '') {
        $requestedProjectId = null;
    }

    if (!$websiteUrl) {
        respondError('Website URL is required', 400);
    }

    // Default project name to domain if empty
    if (empty($projectName)) {
        $parsedUrl = parse_url($websiteUrl);
        $projectName = ($parsedUrl['host'] ?? 'Domain') . ' Audit';
    }

    // Validate URL syntax and basic SSRF safety before queuing background scan
    if (!filter_var($websiteUrl, FILTER_VALIDATE_URL)) {
        respondError('Invalid website URL', 400);
    }

    $safeUrl = validateSafeRemoteUrl($websiteUrl, ['skip_dns' => true]);
    if (!$safeUrl['ok']) {
        respondError('Invalid or restricted website URL: ' . $safeUrl['error'], 400);
    }

    if ($sitemapUrl !== null && trim((string)$sitemapUrl) !== '') {
        $safeSitemap = validateSafeRemoteUrl($sitemapUrl, [
            'skip_dns' => true,
            'base_url' => $websiteUrl,
            'scope_base_url' => $websiteUrl,
        ]);
        if (!$safeSitemap['ok']) {
            respondError('Invalid or restricted sitemap URL: ' . $safeSitemap['error'], 400);
        }
        $sitemapUrl = $safeSitemap['url'];
    } else {
        $sitemapUrl = null;
    }

    $created = createProjectIfNoDuplicate(
        $websiteUrl,
        $projectName,
        $sitemapUrl,
        $useSitemap,
        $requestedProjectId,
        function ($url) {
            return normalizeUrl($url, $url);
        }
    );

    if (!$created['ok']) {
        respondError($created['error'], $created['code']);
    }

    $projectId = $created['project_id'];
    logMessage($projectId, 'INFO', "Project '{$projectName}' created for: {$websiteUrl}");

    // Start background processing (non-blocking)
    $workerStarted = startBackgroundProcess($projectId);
    if (!$workerStarted) {
        updateProject($projectId, function ($proj) {
            $proj['status'] = 'failed';
            $proj['error'] = 'Failed to start background worker';
            $proj['updated_at'] = date('Y-m-d H:i:s');
            return $proj;
        });
        logMessage($projectId, 'ERROR', 'Failed to start background worker');
        respondError('Failed to start background worker', 500);
    }

    respondSuccess([
        'project_id' => $projectId,
        'status' => 'initializing',
        'message' => 'Project created and processing started in background',
        'worker_started' => $workerStarted
    ]);
}

/**
 * Get project status
 */
function handleStatus() {
    $projectId = $_GET['project_id'] ?? null;

    if (!$projectId) {
        respondError('Project ID is required', 400);
    }
    if (!isValidProjectId($projectId)) {
        respondError('Invalid project ID', 400);
    }

    recoverStaleProjectIfNeeded($projectId);
    $projectRes = loadProjectResult($projectId);

    if (!$projectRes['ok']) {
        if ($projectRes['status'] === 'missing') {
            respondError('Project not found', 404);
        }
        respondError('Failed to load project data', 500);
    }
    $project = $projectRes['data'];

    // Load recent logs
    $logs = loadRecentLogs($projectId, 20);

    respondSuccess([
        'project' => $project,
        'logs' => $logs
    ]);
}

/**
 * List all projects
 */
function handleList() {
    $files = glob(PROJECTS_DIR . '/*.json');
    $projects = [];

    if ($files) {
        foreach ($files as $file) {
            $projectId = basename($file, '.json');
            if (!isValidProjectId($projectId)) {
                continue;
            }
            $data = loadProject($projectId);
            if ($data && in_array($data['status'] ?? null, ACTIVE_SCAN_STATUSES, true)) {
                $recovery = recoverStaleProjectIfNeeded($projectId);
                if (!empty($recovery['project'])) {
                    $data = $recovery['project'];
                }
            }
            if ($data) {
                // Only include summary data
                $projects[] = [
                    'id' => $data['id'],
                    'project_name' => $data['project_name'] ?? 'Unnamed Project',
                    'website_url' => $data['website_url'],
                    'status' => $data['status'],
                    'created_at' => $data['created_at'],
                    'updated_at' => $data['updated_at'],
                    'progress' => $data['progress']
                ];
            }
        }
    }

    // Sort by created_at desc
    usort($projects, function($a, $b) {
        return strtotime($b['created_at']) - strtotime($a['created_at']);
    });

    respondSuccess(['projects' => $projects]);
}

/**
 * Delete a project
 */
function handleDelete() {
    $projectId = $_POST['project_id'] ?? $_GET['project_id'] ?? null;

    if (!$projectId) {
        respondError('Project ID is required', 400);
    }
    if (!isValidProjectId($projectId)) {
        respondError('Invalid project ID', 400);
    }

    $deleted = deleteProjectSafely($projectId);
    if (!$deleted['ok']) {
        respondError($deleted['error'], $deleted['code']);
    }

    respondSuccess(['message' => 'Project deleted successfully']);
}

/**
 * Pause a project
 */
function handlePause() {
    $projectId = $_POST['project_id'] ?? $_GET['project_id'] ?? null;
    if (!$projectId) respondError('Project ID is required');
    if (!isValidProjectId($projectId)) respondError('Invalid project ID', 400);

    recoverStaleProjectIfNeeded($projectId);

    $update = updateProject($projectId, function ($project, &$abortReason) {
        if (in_array($project['status'] ?? null, ['completed', 'failed', 'paused'], true)) {
            $abortReason = 'Project cannot be paused in current state';
            return null;
        }
        $project['status'] = 'paused';
        $project['updated_at'] = date('Y-m-d H:i:s');
        return $project;
    });

    if (!$update['ok']) {
        if ($update['status'] === 'missing') {
            respondError('Project not found');
        }
        if ($update['status'] === 'aborted') {
            respondError($update['error']);
        }
        respondError('Failed to update project state', 500);
    }

    logMessage($projectId, 'WARNING', 'Process paused by user');
    respondSuccess(['message' => 'Project paused']);
}

/**
 * Resume a project
 */
function handleResume() {
    $projectId = $_POST['project_id'] ?? $_GET['project_id'] ?? null;
    if (!$projectId) respondError('Project ID is required');
    if (!isValidProjectId($projectId)) respondError('Invalid project ID', 400);

    recoverStaleProjectIfNeeded($projectId);

    $currentRes = loadProjectResult($projectId);
    if (!$currentRes['ok']) {
        if ($currentRes['status'] === 'missing') {
            respondError('Project not found');
        }
        respondError('Failed to load project data', 500);
    }

    if (($currentRes['data']['status'] ?? null) === 'paused' && !isWorkerLockHeld($projectId)) {
        updateProject($projectId, function ($project) {
            if (($project['status'] ?? null) !== 'paused') {
                return null;
            }
            $nowStr = date('Y-m-d H:i:s');
            $project['status'] = 'failed';
            $project['error'] = 'Worker process is no longer running; scan cannot be resumed and can be restarted.';
            $project['recovered_at'] = $nowStr;
            $project['updated_at'] = $nowStr;
            return $project;
        });
        respondError('Worker process is no longer running; scan marked as failed', 409);
    }

    $update = updateProject($projectId, function ($project, &$abortReason) {
        if (($project['status'] ?? null) !== 'paused') {
            $abortReason = 'Project is not in a paused state';
            return null;
        }
        $nowStr = date('Y-m-d H:i:s');
        $project['status'] = 'checking'; // Resume to checking state
        $project['heartbeat_at'] = $nowStr;
        $project['updated_at'] = $nowStr;
        return $project;
    });

    if (!$update['ok']) {
        if ($update['status'] === 'missing') {
            respondError('Project not found');
        }
        if ($update['status'] === 'aborted') {
            respondError($update['error']);
        }
        respondError('Failed to update project state', 500);
    }

    logMessage($projectId, 'SUCCESS', 'Process resumed by user');
    respondSuccess(['message' => 'Project resumed']);
}

/**
 * Export results
 */
function handleExport() {
    $projectId = $_GET['project_id'] ?? null;
    $format = $_GET['format'] ?? 'csv';

    if (!$projectId) {
        respondError('Project ID is required', 400);
    }
    if (!isValidProjectId($projectId)) {
        respondError('Invalid project ID', 400);
    }
    
    $projectRes = loadProjectResult($projectId);

    if (!$projectRes['ok']) {
        if ($projectRes['status'] === 'missing') {
            respondError('Project not found', 404);
        }
        respondError('Failed to load project data', 500);
    }
    $project = $projectRes['data'];

    if ($format === 'csv') {
        exportToCsv($project);
    } else if ($format === 'json') {
        $safeName = preg_replace('/[^a-zA-Z0-9]/', '_', $project['project_name'] ?? $project['id']);
        header('Content-Type: application/json');
        header('Content-Disposition: attachment; filename="' . $safeName . '_results.json"');
        echo json_encode($project['results'], JSON_PRETTY_PRINT);
        exit;
    } else {
        respondError('Invalid format', 400);
    }
}

/**
 * Download generated sitemap
 */
function handleDownloadSitemap() {
    $projectId = $_GET['project_id'] ?? null;

    if (!$projectId) {
        respondError('Project ID is required', 400);
    }
    if (!isValidProjectId($projectId)) {
        respondError('Invalid project ID', 400);
    }

    $projectRes = loadProjectResult($projectId);

    if (!$projectRes['ok']) {
        if ($projectRes['status'] === 'missing') {
            respondError('Sitemap not found for this project', 404);
        }
        respondError('Failed to load project data', 500);
    }
    $project = $projectRes['data'];

    if (!isset($project['output_sitemap']) || !storageIsSafeFilename($project['output_sitemap'])) {
        respondError('Sitemap not found for this project', 404);
    }

    $sitemapFile = SITEMAPS_DIR . '/' . $project['output_sitemap'];

    if (!file_exists($sitemapFile) || !storagePathWithinDir(SITEMAPS_DIR, $sitemapFile)) {
        respondError('Sitemap file does not exist on disk', 404);
    }

    $safeName = preg_replace('/[^a-zA-Z0-9]/', '_', $project['project_name'] ?? $project['id']);
    header('Content-Type: application/xml');
    header('Content-Disposition: attachment; filename="' . $safeName . '_sitemap.xml"');
    readfile($sitemapFile);
    exit;
}

/**
 * Get project logs
 */
function handleLogs() {
    $projectId = $_GET['project_id'] ?? null;
    $limit = (int)($_GET['limit'] ?? 50);

    if (!$projectId) {
        respondError('Project ID is required', 400);
    }
    if (!isValidProjectId($projectId)) {
        respondError('Invalid project ID', 400);
    }

    $logs = loadRecentLogs($projectId, $limit);

    respondSuccess(['logs' => $logs]);
}

/**
 * Start the worker using the PHP runtime that serves this project.
 */
function startBackgroundProcess($projectId) {
    // Keep the site's CLI and web runtimes aligned. Retain the hosted server's
    // custom PHP path when present, otherwise use the current PHP executable.
    $phpBinary = (PHP_OS_FAMILY !== 'Windows' && file_exists('/usr/bin/php83'))
        ? '/usr/bin/php83'
        : PHP_BINARY;
    
    // Worker script path
    $workerScript = __DIR__ . '/worker.php';
    
    // Log the command for debugging
    logMessage($projectId, 'INFO', "PHP Binary: {$phpBinary}");
    logMessage($projectId, 'INFO', "Worker Script: {$workerScript}");
    
    // Check if PHP binary exists
    if (!file_exists($phpBinary)) {
        logMessage($projectId, 'ERROR', 'PHP binary not found at: ' . $phpBinary);
        return false;
    }
    
    // Check if worker script exists
    if (!file_exists($workerScript)) {
        logMessage($projectId, 'ERROR', 'Worker script not found at: ' . $workerScript);
        return false;
    }
    
    // Make sure worker is executable
    @chmod($workerScript, 0755);
    
    $logFile = LOGS_DIR . '/' . $projectId . '_worker.log';
    if (PHP_OS_FAMILY === 'Windows') {
        // XAMPP and the PHP development server run on Windows, where nohup is
        // unavailable. `start` detaches the worker so the HTTP response returns.
        $command = 'start "" /B ' . escapeshellarg($phpBinary) . ' '
            . escapeshellarg($workerScript) . ' ' . escapeshellarg($projectId)
            . ' > ' . escapeshellarg($logFile) . ' 2>&1';
        logMessage($projectId, 'INFO', 'Starting Windows worker process');
        $process = function_exists('popen') ? @popen($command, 'r') : false;
        if (is_resource($process)) {
            pclose($process);
            $returnVar = 0;
            $output = [];
        } else {
            $returnVar = 1;
            $output = ['Unable to start a detached PHP worker process'];
        }
    } else {
        $command = 'nohup ' . escapeshellarg($phpBinary) . ' '
            . escapeshellarg($workerScript) . ' ' . escapeshellarg($projectId)
            . ' > ' . escapeshellarg($logFile) . ' 2>&1 &';
        logMessage($projectId, 'INFO', 'Starting background worker process');
        exec($command, $output, $returnVar);
    }
    
    if ($returnVar !== 0) {
        logMessage($projectId, 'ERROR', 'Failed to start worker. Return code: ' . $returnVar);
        if (!empty($output)) {
            logMessage($projectId, 'ERROR', 'Output: ' . implode("\n", $output));
        }
        return false;
    }
    
    logMessage($projectId, 'INFO', 'Background worker command executed successfully');
    
    // Give the worker a moment to start
    sleep(1);
    
    // Check if worker actually started by looking for its log
    $workerLog = LOGS_DIR . '/' . $projectId . '.log';
    if (file_exists($workerLog)) {
        $logContent = file_get_contents($workerLog);
        if (strpos($logContent, 'WORKER STARTED') !== false) {
            logMessage($projectId, 'SUCCESS', 'Worker confirmed started');
            return true;
        }
    }
    
    // If we can't confirm worker started, log it but don't fail
    logMessage($projectId, 'WARNING', 'Could not confirm worker started (log not yet written)');
    return true; // Assume it started anyway
}

/**
 * Export to CSV
 */
function exportToCsv($project) {
    $safeName = preg_replace('/[^a-zA-Z0-9]/', '_', $project['project_name'] ?? $project['id']);
    header('Content-Type: text/csv');
    header('Content-Disposition: attachment; filename="' . $safeName . '_results.csv"');
    
    $output = fopen('php://output', 'w');
    
    // Write header
    fputcsv($output, ['URL', 'Status', 'Details', 'Occurrences', 'Checked At']);
    
    // Write data
    if (!empty($project['results'])) {
        foreach ($project['results'] as $result) {
            fputcsv($output, [
                $result['url'],
                $result['status'],
                $result['details'] ?? '',
                $result['occurrences'] ?? 0,
                $result['checked_at']
            ]);
        }
    }
    
    fclose($output);
    exit;
}

/**
 * Load recent logs
 */
function loadRecentLogs($projectId, $limit = 50) {
    if (!isValidProjectId($projectId)) {
        return [];
    }
    $logFile = projectLogPath($projectId);
    
    if (!file_exists($logFile)) {
        return [];
    }
    
    $lines = @file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!$lines) return [];
    
    $lines = array_reverse($lines);
    $lines = array_slice($lines, 0, $limit);
    
    $logs = [];
    foreach ($lines as $line) {
        // Parse log line: [timestamp] [level] message
        if (preg_match('/\[(.*?)\]\s*\[(.*?)\]\s*(.*)/', $line, $matches)) {
            $logs[] = [
                'timestamp' => $matches[1],
                'level' => $matches[2],
                'message' => $matches[3]
            ];
        }
    }
    
    return array_reverse($logs);
}

/**
 * Log message
 */
function logMessage($projectId, $level, $message) {
    if (!isValidProjectId($projectId)) {
        error_log("[api] [{$level}] {$message}");
        return;
    }
    $timestamp = date('Y-m-d H:i:s');
    $logEntry = "[{$timestamp}] [{$level}] {$message}\n";

    $logFile = projectLogPath($projectId);
    @file_put_contents($logFile, $logEntry, FILE_APPEND | LOCK_EX);
}

/**
 * Send success response
 */
function respondSuccess($data) {
    echo json_encode([
        'success' => true,
        'data' => $data
    ]);
    exit;
}

/**
 * Send error response
 */
function respondError($message, $code = 400) {
    http_response_code($code);
    echo json_encode([
        'success' => false,
        'error' => $message
    ]);
    exit;
}
