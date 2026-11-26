# Lorem Ipsum Checker - Improved Async Version

A professional, non-blocking Lorem Ipsum detection system that supports multiple concurrent projects.

## 🚀 Key Improvements

### 1. **Non-Blocking "Push and Forget" Architecture**
- API returns immediately after project creation
- Background worker handles all processing
- No more hanging requests or timeouts

### 2. **Automatic Sitemap Detection & Generation**
- Automatically tries multiple common sitemap locations
- Supports sitemap indexes (recursive parsing)
- Falls back to website crawling if no sitemap found
- Single unified workflow

### 3. **Multi-Project Support**
- Process multiple websites simultaneously
- Each project runs independently in background
- File locking prevents race conditions

### 4. **Real-Time Progress Tracking**
- Frontend polls for updates every 3 seconds
- Live progress bars and statistics
- Real-time log streaming

## 📋 Requirements

- PHP 7.4 or higher
- PHP extensions: `curl`, `xml`, `dom`, `json`
- Apache/Nginx with mod_rewrite (optional)
- Command line access for background workers

## 🔧 Installation

### 1. Upload Files

Upload these files to your server:
```
/your-directory/
├── api_improved.php       ← Main API endpoint
├── worker.php            ← Background worker
├── index_improved.html   ← Frontend interface
├── config.php            ← Configuration (existing)
└── data/                 ← Will be created automatically
    ├── projects/
    ├── logs/
    ├── sitemaps/
    └── locks/
```

### 2. Set Permissions

```bash
chmod 755 api_improved.php worker.php
chmod 644 index_improved.html config.php
mkdir -p data/{projects,logs,sitemaps,locks}
chmod 777 data data/projects data/logs data/sitemaps data/locks
```

### 3. Test PHP CLI Access

```bash
php -v
# Should show PHP 7.4 or higher
```

### 4. Verify Background Execution

Test if background processes work:

```bash
# On Linux/Mac
php worker.php test_project &

# On Windows
start /B php worker.php test_project
```

## 🎯 Usage

### Via Web Interface

1. Open `index_improved.html` in your browser
2. Enter website URL
3. Click "Start Checking"
4. Watch real-time progress updates
5. Export results when complete

### Via API

#### Start a Project

```bash
curl -X POST http://your-domain.com/api_improved.php \
  -d "action=start" \
  -d "website_url=https://example.com" \
  -d "use_sitemap=true"
```

Response:
```json
{
  "success": true,
  "data": {
    "project_id": "project_abc123_1234567890",
    "status": "initializing",
    "message": "Project created and processing started in background"
  }
}
```

#### Check Status

```bash
curl "http://your-domain.com/api_improved.php?action=status&project_id=project_abc123_1234567890"
```

#### List All Projects

```bash
curl "http://your-domain.com/api_improved.php?action=list"
```

#### Delete Project

```bash
curl -X POST http://your-domain.com/api_improved.php \
  -d "action=delete" \
  -d "project_id=project_abc123_1234567890"
```

#### Export Results

```bash
# CSV export
curl "http://your-domain.com/api_improved.php?action=export&project_id=PROJECT_ID&format=csv" -O

# JSON export
curl "http://your-domain.com/api_improved.php?action=export&project_id=PROJECT_ID&format=json" -O
```

## 🔄 How It Works

### Workflow

```
1. User submits website URL
   ↓
2. API creates project (responds immediately)
   ↓
3. Background worker starts automatically
   ↓
4. Worker detects/generates sitemap
   ↓
5. Worker extracts all URLs
   ↓
6. Worker checks each URL for Lorem Ipsum
   ↓
7. Project marked as completed
   ↓
8. User can export results
```

### Project Statuses

- `initializing` - Project just created
- `detecting_sitemap` - Looking for sitemap.xml
- `generating_sitemap` - Crawling website to generate sitemap
- `extracting` - Extracting URLs from sitemap
- `checking` - Checking URLs for Lorem Ipsum
- `completed` - All done!
- `failed` - Something went wrong

## 🎨 Features

### Automatic Sitemap Handling

The system tries these locations in order:
1. Custom sitemap URL (if provided)
2. `/sitemap.xml`
3. `/sitemap_index.xml`
4. `/sitemap-index.xml`
5. `/sitemap1.xml`
6. `/wp-sitemap.xml`

If no sitemap found, it automatically:
- Crawls the website (max depth 3)
- Generates a sitemap
- Proceeds with Lorem Ipsum checking

### Concurrent Processing

Multiple projects can run simultaneously:
- Each project has its own background worker
- File locking prevents data corruption
- Independent progress tracking

### Real-Time Updates

Frontend automatically:
- Polls for status every 3 seconds
- Updates progress bars
- Shows live statistics
- Streams recent logs

## ⚙️ Configuration

Edit `config.php` to customize:

```php
'crawler' => [
    'max_urls' => 500,      // Maximum URLs to crawl
    'max_depth' => 3,       // Maximum crawl depth
    'timeout' => 30,        // Request timeout
],

'detection' => [
    'patterns' => [
        '/lorem\s+ipsum/i',
        '/dolor\s+sit\s+amet/i',
        // Add more patterns
    ],
],
```

## 🐛 Troubleshooting

### Workers Not Starting

**Problem**: Projects stuck in "initializing"

**Solution**:
```bash
# Test manual worker execution
php worker.php test_project

# Check PHP CLI path
which php

# Update api_improved.php line 150 with correct PHP path
```

### Permission Errors

**Problem**: "Failed to create directory"

**Solution**:
```bash
chmod 777 data
chmod 777 data/*
```

### Background Process Not Working on Windows

**Problem**: Projects don't process

**Solution**:
```bash
# Use this command format in api_improved.php (line 153):
start /B php worker.php {$projectId}
```

### High Server Load

**Problem**: Too many concurrent crawls

**Solution**:
- Limit concurrent projects
- Increase crawl delays in worker.php
- Reduce max_urls in config.php

## 📊 Performance Tips

1. **Use Sitemaps When Possible**
   - Much faster than crawling
   - More reliable
   - Lower server load

2. **Adjust Delays**
   - Increase `sleep()` values for slower servers
   - Decrease for faster processing

3. **Limit Concurrent Projects**
   - Monitor server resources
   - Implement queue system if needed

## 🔒 Security Considerations

1. **Add Authentication**
   - API is currently public
   - Add API keys or OAuth

2. **Rate Limiting**
   - Enable in config.php
   - Prevent abuse

3. **Domain Restrictions**
   - Set `allowed_domains` in config.php
   - Prevent checking unauthorized sites

4. **Input Validation**
   - Always validate URLs
   - Sanitize user input

## 📝 File Structure

```
data/
├── projects/
│   └── project_abc123.json    ← Project state
├── logs/
│   └── project_abc123.log     ← Processing logs
├── sitemaps/
│   └── project_abc123_urls.json  ← Extracted URLs
└── locks/
    └── project_abc123.lock    ← File locks
```

## 🎯 Migration from Old System

To migrate from your old system:

1. Keep existing files as backup
2. Deploy new files with different names
3. Test with `index_improved.html`
4. Once confirmed working, replace old files
5. No database migration needed (JSON-based)

## 💡 Tips

- **Start Small**: Test with small websites first
- **Monitor Logs**: Check logs for any issues
- **Use Sitemaps**: Much faster and more reliable
- **Be Polite**: Respect crawl delays and robots.txt

## 🤝 Support

If you encounter issues:

1. Check browser console for errors
2. Review project logs
3. Test worker manually: `php worker.php PROJECT_ID`
4. Check file permissions
5. Verify PHP CLI is working

## 📄 License

Free to use and modify for your needs.

---

**Version**: 2.0 (Async)  
**Author**: Claude  
**Last Updated**: February 2026
