<?php
/**
 * Lorem Ipsum Checker - Configuration
 * Customize these settings according to your needs
 */

return [
    
    // API Settings
    'api' => [
        'max_execution_time' => 300,        // Maximum time for processing (seconds)
        'request_delay' => 2,                // Delay between URL checks (seconds)
        'user_agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ],
    
    // Crawler Settings
    'crawler' => [
        'max_urls' => 100,                   // Maximum URLs to crawl (if no sitemap)
        'max_depth' => 2,                    // Maximum crawl depth
        'timeout' => 30,                     // Request timeout (seconds)
        'follow_redirects' => true,          // Follow HTTP redirects
        'verify_ssl' => false,               // Verify SSL certificates
        'max_retries' => 3,                  // Bounded retry attempts for transient failures
        'retry_delay' => 2,                  // Base backoff delay (seconds)
        'max_retry_after' => 15,             // Maximum Retry-After wait honored (seconds)
        'max_redirects' => 5,                // Maximum HTTP redirects followed
        'js_shell_min_text_length' => 40,    // Minimum visible body text length for JS-shell heuristic
        'concurrency' => 5,                  // Concurrent page fetch slots (max 10)
        'per_host_concurrency' => 2,         // Max concurrent requests per host (max 3)
        'scheduler_poll_ms' => 50,           // Multi-curl select/poll interval (ms)
    ],
    
    // Detection Settings
    'detection' => [
        'patterns' => [
            '/lorem\s+ipsum/i',
            '/dolor\s+sit\s+amet/i',
            '/consectetur\s+adipiscing/i',
            '/ipsum\s+dolor/i',
        ],
        'case_sensitive' => false,
    ],
    
    // Storage Settings
    'storage' => [
        'data_dir' => __DIR__ . '/data',
        'projects_dir' => __DIR__ . '/data/projects',
        'logs_dir' => __DIR__ . '/data/logs',
        'auto_cleanup' => false,             // Auto-delete old projects
        'cleanup_days' => 30,                // Delete projects older than X days
    ],
    
    // Export Settings
    'export' => [
        'csv_delimiter' => ',',
        'csv_encoding' => 'UTF-8',
        'include_timestamp' => true,
    ],
    
    // Rate Limiting (optional)
    'rate_limit' => [
        'enabled' => false,
        'max_requests_per_hour' => 100,
    ],
    
    // Sitemap Settings
    'sitemap' => [
        'common_locations' => [
            '/sitemap.xml',
            '/sitemap_index.xml',
            '/sitemap-index.xml',
            '/sitemap.txt',
            '/sitemaps/sitemap.xml',
            '/wp-sitemap.xml',
            '/sitemap1.xml',
            '/sitemap.xml.gz',
        ],
        'max_size' => 10 * 1024 * 1024,     // 10MB max sitemap/decompressed size
        'max_urls' => 500,                   // Maximum discovered URLs across sources
        'max_depth' => 5,                    // Maximum recursive sitemap index depth
        'max_sitemaps' => 50,                // Maximum child sitemaps fetched per scan
        'max_feed_entries' => 100,           // Maximum RSS/Atom feed entries processed
    ],
    
    // Security Settings
    'security' => [
        'allowed_domains' => [],             // Empty = all domains allowed
        'blocked_domains' => [],             // Domains to block
        'allowed_ips' => [],                 // Empty = all IPs allowed
    ],
    
    // Debug Settings
    'debug' => [
        'enabled' => false,                  // Enable debug mode
        'log_requests' => false,             // Log all HTTP requests
        'verbose' => false,                  // Verbose error messages
    ],
    
];