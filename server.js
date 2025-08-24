import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import FormData from 'form-data';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Configuration
const CONFIG = {
  STREAM_API_KEYS: [
    'df9c7330b4c1807041d5d386',
    '1042fc7f00df7e878f3ca270',
    '79d324569b3e0f16a11bb79c',
    '74f596a5c7f2c16747eba33c',
    '757245d8037f14775b9cfef8',
    '82f9520d915e75bbe1df1c93'
  ],
  TMDB_API_KEY: 'b85ea590b2ffd2a8d04e068fc069001e',
  DASHBOARD_PASSWORD: 'Alien101',
  STREAM_API_BASE: 'https://streamp2p.com/api/v1/video/manage',
  STREAM_UPLOAD_BASE: 'https://streamp2p.com/api/v1/video',
  TMDB_BASE_URL: 'https://api.themoviedb.org/3'
};

const DATA_FILE = path.join(__dirname, 'requests.json');
const LOG_FILE = path.join(__dirname, 'server.log');

// Global state
let currentKeyIndex = 0;
let ipTracker = {};
let renameProgress = { running: false, current: 0, total: 0, status: '', failures: [] };
let uploadProgress = { running: false, current: 0, total: 0, status: '', uploads: [] };
let duplicateProgress = { running: false, current: 0, total: 0, status: '', duplicates: [] };

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10GB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v)$/i;
    cb(null, allowedTypes.test(file.originalname));
  }
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Utilities
const getApiKey = () => {
  const key = CONFIG.STREAM_API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % CONFIG.STREAM_API_KEYS.length;
  return key;
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const log = (message, level = 'INFO') => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${level}: ${message}`;
  console.log(logMessage);
  fs.appendFileSync(LOG_FILE, logMessage + '\n');
};

const readData = () => {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, '[]');
      return [];
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    log(`Error reading data file: ${error.message}`, 'ERROR');
    return [];
  }
};

const writeData = (data) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    log(`Error writing data file: ${error.message}`, 'ERROR');
  }
};

// Normalization for exact matching (strips all special chars)
const normalize = (str) => str?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';

// Normalization for title matching (keeps spaces)
const normalizeTitle = (str) => str?.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim() || '';

// Enhanced episode extraction
const extractSeasonEpisode = (name = '') => {
  const patterns = [
    /s(\d{1,2})[.\-_\s]?e(\d{1,3})/i, // Supports E01 to E999
    /season[\s\-_]*(\d{1,2})[\s\-_]*episode[\s\-_]*(\d{1,3})/i,
    /(\d{1,2})x(\d{1,3})/i,
    /ep[\s\-_]*(\d{1,3})/i // For formats like "Ep 5"
  ];

  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (match) {
        if (match.length === 3) { // s01e01, 1x01 format
             return {
                season: parseInt(match[1]),
                episode: parseInt(match[2])
            };
        } else if (match.length === 2) { // ep 01 format (no season)
            return {
                season: null,
                episode: parseInt(match[1])
            }
        }
    }
  }
  return { season: null, episode: null };
};

// Enhanced TMDB series info fetching
const getTMDBSeriesInfo = async (seriesId) => {
  try {
    const response = await axios.get(`${CONFIG.TMDB_BASE_URL}/tv/${seriesId}`, {
      params: { api_key: CONFIG.TMDB_API_KEY }
    });
    
    const series = response.data;
    const seasonInfo = {};
    
    for (const season of series.seasons) {
      if (season.season_number > 0) { // Skip specials
        seasonInfo[season.season_number] = {
          episodeCount: season.episode_count,
          name: season.name,
          airDate: season.air_date
        };
      }
    }
    
    return {
      name: series.name,
      totalSeasons: series.number_of_seasons,
      totalEpisodes: series.number_of_episodes,
      seasons: seasonInfo
    };
  } catch (error) {
    log(`Error fetching TMDB series info: ${error.message}`, 'ERROR');
    return null;
  }
};

// Extract TMDB ID from filename
const extractTMDBId = (filename) => {
  const match = filename.match(/\{(\d+)\}/);
  return match ? match[1] : null;
};

// Organize series episodes
const organizeSeriesEpisodes = (videos) => {
  const organized = {};
  
  videos.forEach(video => {
    const { season, episode } = extractSeasonEpisode(video.name);
    const tmdbId = extractTMDBId(video.name);
    
    if (season && episode && tmdbId) {
      if (!organized[tmdbId]) {
        organized[tmdbId] = {
          seriesName: video.name.split('S')[0].trim().replace(/\{.*?\}/g, '').trim(),
          tmdbId: tmdbId,
          seasons: {}
        };
      }
      
      if (!organized[tmdbId].seasons[season]) {
        organized[tmdbId].seasons[season] = {};
      }
      
      organized[tmdbId].seasons[season][episode] = video;
    }
  });
  
  return organized;
};

// Check for missing episodes
const checkMissingEpisodes = async (organizedSeries) => {
  const results = {};
  
  for (const [tmdbId, seriesData] of Object.entries(organizedSeries)) {
    const tmdbInfo = await getTMDBSeriesInfo(tmdbId);
    if (!tmdbInfo) continue;
    
    results[tmdbId] = {
      seriesName: seriesData.seriesName,
      tmdbId: tmdbId,
      seasons: {},
      summary: {
        totalSeasons: tmdbInfo.totalSeasons,
        seasonsAvailable: Object.keys(seriesData.seasons).length,
        missingSeasons: []
      }
    };
    
    // Check each season
    for (let seasonNum = 1; seasonNum <= tmdbInfo.totalSeasons; seasonNum++) {
      const expectedEpisodes = tmdbInfo.seasons[seasonNum]?.episodeCount || 0;
      const availableEpisodes = seriesData.seasons[seasonNum] || {};
      const availableCount = Object.keys(availableEpisodes).length;
      
      if (availableCount === 0) {
        results[tmdbId].summary.missingSeasons.push(seasonNum);
      }
      
      const missingEpisodes = [];
      for (let ep = 1; ep <= expectedEpisodes; ep++) {
        if (!availableEpisodes[ep]) {
          missingEpisodes.push(ep);
        }
      }
      
      results[tmdbId].seasons[seasonNum] = {
        name: tmdbInfo.seasons[seasonNum]?.name || `Season ${seasonNum}`,
        expectedEpisodes: expectedEpisodes,
        availableEpisodes: availableCount,
        missingEpisodes: missingEpisodes,
        episodes: Object.keys(availableEpisodes)
          .sort((a, b) => parseInt(a) - parseInt(b))
          .map(epNum => availableEpisodes[epNum])
      };
    }
  }
  
  return results;
};

// Enhanced video search with pagination
const searchAllVideos = async (searchTerm = '', exactMatch = false) => {
  let allVideos = [];
  let page = 1;
  const perPage = 200;
  
  try {
    // First request to get total count
    const firstResponse = await axios.get(CONFIG.STREAM_API_BASE, {
      params: { page: 1, perPage, search: searchTerm },
      headers: { 'api-token': getApiKey() }
    });

    const { data, metadata } = firstResponse.data;
    allVideos.push(...data);

    // Continue fetching remaining pages if needed
    if (metadata.maxPage > 1) {
      const promises = [];
      for (let p = 2; p <= metadata.maxPage; p++) {
        promises.push(
          axios.get(CONFIG.STREAM_API_BASE, {
            params: { page: p, perPage, search: searchTerm },
            headers: { 'api-token': getApiKey() }
          }).then(res => res.data.data)
        );
        
        // Rate limiting: batch requests
        if (promises.length >= 3) {
          const results = await Promise.all(promises);
          results.forEach(batch => allVideos.push(...batch));
          promises.length = 0;
          await delay(500);
        }
      }
      
      // Handle remaining promises
      if (promises.length > 0) {
        const results = await Promise.all(promises);
        results.forEach(batch => allVideos.push(...batch));
      }
    }

    // Apply additional filtering if exact match requested
    if (exactMatch && searchTerm) {
      const normalized = normalize(searchTerm);
      allVideos = allVideos.filter(video => 
        normalize(video.name).includes(normalized)
      );
    }

    log(`Found ${allVideos.length} videos for search: "${searchTerm}"`);
    return allVideos;
    
  } catch (error) {
    log(`Error searching videos: ${error.message}`, 'ERROR');
    throw error;
  }
};

// Enhanced upload status check
const checkUploadStatus = async (taskId) => {
  try {
    const response = await axios.get(`${CONFIG.STREAM_UPLOAD_BASE}/advance-upload/${taskId}`, {
      headers: { 'api-token': getApiKey() }
    });
    return response.data;
  } catch (error) {
    log(`Check upload status failed: ${error.message}`, 'ERROR');
    throw error;
  }
};

// Delete video
const deleteVideo = async (videoId) => {
  try {
    await axios.delete(`${CONFIG.STREAM_API_BASE}/${videoId}`, {
      headers: { 'api-token': getApiKey() }
    });
    log(`Video deleted: ${videoId}`);
    return true;
  } catch (error) {
    log(`Delete failed [${videoId}]: ${error.message}`, 'ERROR');
    return false;
  }
};

// NEW: Clone video
const cloneVideo = async (videoId) => {
  try {
    const response = await axios.post(CONFIG.STREAM_API_BASE, {
      videoId: videoId
    }, {
      headers: {
        'api-token': getApiKey(),
        'Content-Type': 'application/json'
      }
    });
    log(`Video cloned: ${videoId}. New ID: ${response.data.id}`);
    return { success: true, newId: response.data.id };
  } catch (error) {
    log(`Clone failed [${videoId}]: ${error.message}`, 'ERROR');
    return { success: false, error: error.message };
  }
};

// Find duplicates
const findDuplicates = (videos) => {
  const duplicates = {};
  const nameMap = {};
  
  videos.forEach(video => {
    const normalizedName = normalize(video.name);
    if (nameMap[normalizedName]) {
      if (!duplicates[normalizedName]) {
        duplicates[normalizedName] = {
          originalName: nameMap[normalizedName].name,
          videos: [nameMap[normalizedName]]
        };
      }
      duplicates[normalizedName].videos.push(video);
    } else {
      nameMap[normalizedName] = video;
    }
  });
  
  return Object.values(duplicates);
};

// ===================================================================
// START: REWRITTEN PARSING AND CLEANING LOGIC
// ===================================================================

/**
 * Cleans a title string by removing common junk keywords and formatting.
 * This function is designed to be called AFTER the title has been extracted.
 * @param {string} title - The raw title to clean.
 * @returns {string} - The cleaned title.
 */
const cleanTitle = (title) => {
  if (!title) return '';

  // Comprehensive list of junk keywords and patterns to remove
  const junkRegex = new RegExp([
    // Quality and resolution
    '4k', 'uhd', '2160p', '1080p', '720p', '480p', 'hd',
    // Source and rip type
    'blu-ray', 'bluray', 'brrip', 'bdrip', 'web-dl', 'webrip', 'web', 'hdrip', 'dvdrip',
    'hdts', 'hdcam', 'camrip', 'predvdrip', 'hdtc', 'amzn', 'nf', 'hbo',
    // Video and audio codecs
    'x264', 'h264', 'x265', 'h265', 'hevc', 'avc', '10bit', '8bit',
    'dts-hd', 'dts', 'ac3', 'dd5.1', 'ddp 5.1', 'aac', 'mp3',
    // Audio and subtitle language/info
    'dual audio', 'dual-audio', 'multi-audio', 'hindi', 'english', 'tamil', 'telugu',
    'malayalam', 'kannada', 'japanese', 'chinese', 'korean', 'french', 'spanish', 'norwegian',
    'italian', 'punjabi', 'bengali', 'dubbed', 'org', 'esub', 'esubs', 'msub', 'msubs', 'hc-esub', 'hc-sub',
    // Release groups and websites
    'bollyflix', 'moviesmod', 'themoviesflix', 'moonflix', 'vegamovies', '1337x',
    'yify', 'yts', 'rarbg', 'torrent', 'uncut', 'unrated', 'extended', 'remastered',
    'special edition', 'x-rated', 'reloaded version',
    // Common file extensions and domains (as words)
    'mkv', 'mp4', 'avi', 'com', 'in', 'net', 'org', 'email'
  ].join('|'), 'gi');

  return title
    // Remove content in brackets and curly braces (often junk)
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\{[^}]+\}/g, '')
    // Remove the junk keywords
    .replace(junkRegex, '')
    // Replace dots, underscores, and other separators with spaces
    .replace(/[._\-]+/g, ' ')
    // Remove any remaining parentheses that are now empty or contain only spaces
    .replace(/\(\s*\)/g, '')
    // Collapse multiple spaces into one
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * A much more robust function to parse a video filename into its components.
 * It intelligently finds series/episode or year information first, then cleans the title.
 * @param {string} filename - The full filename (e.g., "Movie.Title.2023.1080p.mkv").
 * @returns {object} - An object with title, year, isSeries, season, and episode.
 */
const parseVideoTitle = (filename) => {
  // Start with the raw filename, remove extension
  let raw = filename.replace(/\.[^.]+$/, '');

  // Handle "AKA" (Also Known As) by taking only the first part
  raw = raw.split(/\sAKA\s/i)[0];

  // --- 1. Attempt to parse as a Series ---
  const seriesPatterns = [
    // Standard: S01E01, S01.E01, S01_E01
    /(.*?)[ \._-]?s(\d{1,2})[ \._-]?e(\d{1,3})/i,
    // Spelled out: Season 01 Episode 01
    /(.*?)season[ \._-]?(\d{1,2})[ \._-]?episode[ \._-]?(\d{1,3})/i,
    // Cross format: 1x01
    /(.*?)(\d{1,2})x(\d{1,3})/i,
    // Simple episode format: Ep 01, Episode 1 (often no season info)
    /(.*?)[ \._-]?(?:ep|episode)[ \._-]?(\d{1,3})/i
  ];

  for (const pattern of seriesPatterns) {
    const match = raw.match(pattern);
    if (match) {
      // For patterns like S01E01 or 1x01
      if (match.length === 4) {
        return {
          title: cleanTitle(match[1]),
          year: null,
          isSeries: true,
          season: parseInt(match[2]),
          episode: parseInt(match[3])
        };
      }
      // For patterns like "Ep 01"
      if (match.length === 3) {
        const titleCandidate = cleanTitle(match[1]);
        // Check if the title has a year, which might indicate the season
        const yearMatch = titleCandidate.match(/\b((?:19|20)\d{2})\b/);
        return {
          title: titleCandidate.replace(/\b((?:19|20)\d{2})\b/, '').trim(),
          year: null,
          isSeries: true,
          season: yearMatch ? parseInt(yearMatch[1]) : 1, // Default to season 1 if no year found
          episode: parseInt(match[2])
        };
      }
    }
  }

  // --- 2. Attempt to parse as a Movie (by finding a year) ---
  // Regex to find a 4-digit year (19xx or 20xx) surrounded by separators or in parentheses
  const yearPattern = /(.*?)[ \._-]?\(?((?:19|20)\d{2})\)?/;
  const yearMatch = raw.match(yearPattern);

  if (yearMatch) {
    // Check if the year is not part of a longer number (like a version)
    const potentialYear = yearMatch[2];
    const textAfterYear = raw.substring(yearMatch[0].length);
    
    // A simple heuristic: if the text after the year starts with a number, it might not be the release year.
    // This is imperfect but helps avoid grabbing years from titles like "2001 A Space Odyssey".
    // A better approach is to assume the *last* such match is the year.
    const allYearMatches = [...raw.matchAll(/\b((?:19|20)\d{2})\b/g)];
    if (allYearMatches.length > 0) {
        const lastMatch = allYearMatches[allYearMatches.length - 1];
        const year = lastMatch[1];
        const title = raw.substring(0, lastMatch.index);
        return {
            title: cleanTitle(title),
            year: parseInt(year),
            isSeries: false,
            season: null,
            episode: null
        };
    }
  }

  // --- 3. Fallback: Treat the whole thing as a movie title with no year ---
  return {
    title: cleanTitle(raw),
    year: null,
    isSeries: false,
    season: null,
    episode: null
  };
};

// ===================================================================
// END: REWRITTEN PARSING AND CLEANING LOGIC
// ===================================================================


// Get IMDB ID from TMDB ID
const getIMDBId = async (tmdbId, type) => {
  try {
    const endpoint = type === 'tv' ? 'tv' : 'movie';
    const response = await axios.get(`${CONFIG.TMDB_BASE_URL}/${endpoint}/${tmdbId}/external_ids`, {
      params: { api_key: CONFIG.TMDB_API_KEY }
    });
    
    return response.data.imdb_id || null;
  } catch (error) {
    log(`Error fetching IMDB ID for TMDB ${tmdbId}: ${error.message}`, 'ERROR');
    return null;
  }
};

// Enhanced TMDB search with IMDB ID fetching
const searchTMDB = async (info) => {
  const type = info.isSeries ? 'tv' : 'movie';

  try {
    const response = await axios.get(`${CONFIG.TMDB_BASE_URL}/search/${type}`, {
      params: {
        api_key: CONFIG.TMDB_API_KEY,
        query: info.title,
        ...(info.year && !info.isSeries ? { year: info.year } : {})
      }
    });

    const results = response.data.results;
    if (!results || results.length === 0) return null;

    // Improved matching: prioritize exact title matches
    const normalizedInfoTitle = info.title.toLowerCase();
    let bestMatch = results.find(r => (r.title || r.name || '').toLowerCase() === normalizedInfoTitle);
    if (!bestMatch) {
        bestMatch = results.find(r => (r.title || r.name || '').toLowerCase().includes(normalizedInfoTitle));
    }
    if (!bestMatch) {
        bestMatch = results[0];
    }

    // Get IMDB ID
    const imdbId = await getIMDBId(bestMatch.id, type);

    if (!info.isSeries) {
      return {
        tmdbId: bestMatch.id,
        imdbId: imdbId,
        title: bestMatch.title || bestMatch.name,
        year: (bestMatch.release_date || bestMatch.first_air_date || '').slice(0, 4)
      };
    }

    // For series, get episode info
    try {
      const epResponse = await axios.get(`${CONFIG.TMDB_BASE_URL}/tv/${bestMatch.id}/season/${info.season}/episode/${info.episode}`, {
        params: { api_key: CONFIG.TMDB_API_KEY }
      });

      return {
        tmdbId: bestMatch.id,
        imdbId: imdbId,
        seriesName: bestMatch.name,
        episodeName: epResponse.data.name || `Episode ${info.episode}`,
        season: info.season,
        episode: info.episode
      };
    } catch (episodeError) {
      // Fallback if episode details not found
      return {
        tmdbId: bestMatch.id,
        imdbId: imdbId,
        seriesName: bestMatch.name,
        episodeName: `Episode ${info.episode}`,
        season: info.season,
        episode: info.episode
      };
    }
  } catch (error) {
    log(`TMDB search error for "${info.title}": ${error.message}`, 'ERROR');
    return null;
  }
};

// Fetch all videos from StreamP2P
const fetchAllVideos = async () => {
  return await searchAllVideos('', false);
};

// Rename video
const renameVideo = async (videoId, newName) => {
  try {
    await axios.patch(`${CONFIG.STREAM_API_BASE}/${videoId}`, {
      name: newName
    }, {
      headers: {
        'api-token': getApiKey(),
        'Content-Type': 'application/json'
      }
    });
    
    log(`Video renamed: ${newName}`);
    return true;
  } catch (error) {
    log(`Rename failed [${videoId}]: ${error.message}`, 'ERROR');
    return false;
  }
};

// API Routes

// Enhanced stream search endpoint with organization
app.get('/api/stream/search', async (req, res) => {
  try {
    const { q: searchTerm = '', exactMatch = false, organize = false } = req.query;
    
    if (!searchTerm.trim()) {
      return res.status(400).json({ 
        success: false, 
        error: 'Search term is required' 
      });
    }

    log(`Stream search request: "${searchTerm}"`);
    
    const videos = await searchAllVideos(searchTerm, exactMatch === 'true');
    
    if (organize === 'true') {
      // Organize series episodes
      const organized = organizeSeriesEpisodes(videos);
      const analyzed = await checkMissingEpisodes(organized);
      
      return res.json({
        success: true,
        count: videos.length,
        organized: true,
        data: analyzed
      });
    }
    
    // Regular search results
    const results = videos.map(video => ({
      id: video.id,
      name: video.name,
      size: video.size,
      duration: video.duration,
      resolution: video.resolution,
      status: video.status,
      createdAt: video.createdAt,
      downloadUrl: `https://moonflix.p2pplay.pro/#${video.id}&dl=1`,
      streamUrl: `https://moonflix.p2pplay.pro/#${video.id}`,
      poster: video.poster,
      preview: video.preview
    }));

    res.json({
      success: true,
      count: results.length,
      organized: false,
      data: results
    });

  } catch (error) {
    log(`Stream search error: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false, 
      error: 'Stream search failed', 
      details: error.message 
    });
  }
});

// Enhanced upload status endpoint
app.get('/api/upload/status/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    
    const status = await checkUploadStatus(taskId);
    
    // Enhanced status information
    const enhancedStatus = {
      ...status,
      statusText: getStatusText(status.status),
      isCompleted: status.status === 'Completed',
      isFailed: status.status === 'Failed',
      isPending: status.status === 'Pending' || status.status === 'Processing',
      videoCount: status.videos ? status.videos.length : 0
    };
    
    res.json({
      success: true,
      data: enhancedStatus
    });

  } catch (error) {
    log(`Upload status check error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Failed to check upload status',
      details: error.message
    });
  }
});

// Get status text helper
const getStatusText = (status) => {
  const statusMap = {
    'Pending': '⏳ Pending',
    'Processing': '⚙️ Processing',
    'Completed': '✅ Completed',
    'Failed': '❌ Failed',
    'Error': '⚠️ Error'
  };
  return statusMap[status] || status;
};

// Duplicate detection endpoint
app.get('/api/duplicates/scan', async (req, res) => {
  if (duplicateProgress.running) {
    return res.status(409).json({ 
      success: false, 
      error: 'Duplicate scan already in progress' 
    });
  }

  try {
    duplicateProgress = { running: true, current: 0, total: 0, status: 'Starting duplicate scan...', duplicates: [] };
    
    res.json({ 
      success: true, 
      message: 'Duplicate scan started. Check progress via /api/duplicates/progress' 
    });

    const videos = await searchAllVideos('', false);
    duplicateProgress.total = videos.length;
    duplicateProgress.status = 'Analyzing videos for duplicates...';

    const duplicates = findDuplicates(videos);
    
    duplicateProgress.duplicates = duplicates.map(dup => ({
      ...dup,
      totalSize: dup.videos.reduce((sum, video) => sum + (video.size || 0), 0),
      duplicateCount: dup.videos.length
    }));

    duplicateProgress.running = false;
    duplicateProgress.current = videos.length;
    duplicateProgress.status = `Scan completed: Found ${duplicates.length} duplicate groups`;
    log(`Duplicate scan completed: ${duplicates.length} groups found`);

  } catch (error) {
    duplicateProgress.running = false;
    duplicateProgress.status = `Error: ${error.message}`;
    log(`Duplicate scan error: ${error.message}`, 'ERROR');
  }
});

// Duplicate progress endpoint
app.get('/api/duplicates/progress', (req, res) => {
  res.json({ success: true, progress: duplicateProgress });
});

// Delete duplicate endpoint
app.delete('/api/duplicates/delete/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    const success = await deleteVideo(videoId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Video deleted successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to delete video'
      });
    }

  } catch (error) {
    log(`Delete video error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Failed to delete video',
      details: error.message
    });
  }
});

// Batch delete duplicates endpoint
app.post('/api/duplicates/batch-delete', async (req, res) => {
  try {
    const { videoIds } = req.body;

    if (!videoIds || !Array.isArray(videoIds)) {
      return res.status(400).json({
        success: false,
        error: 'Video IDs array is required'
      });
    }

    let successful = 0;
    let failed = 0;

    for (const videoId of videoIds) {
      const success = await deleteVideo(videoId);
      if (success) {
        successful++;
      } else {
        failed++;
      }
      await delay(200); // Rate limiting
    }

    res.json({
      success: true,
      message: `Batch delete completed: ${successful} successful, ${failed} failed`,
      stats: { successful, failed, total: videoIds.length }
    });

  } catch (error) {
    log(`Batch delete error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Batch delete failed',
      details: error.message
    });
  }
});

// Enhanced batch upload with status tracking
app.post('/api/upload/batch', async (req, res) => {
  try {
    const { uploads } = req.body;

    if (!uploads || !Array.isArray(uploads)) {
      return res.status(400).json({
        success: false,
        error: 'Uploads array is required'
      });
    }

    if (uploadProgress.running) {
      return res.status(409).json({
        success: false,
        error: 'Batch upload already in progress'
      });
    }

    uploadProgress = {
      running: true,
      current: 0,
      total: uploads.length,
      status: 'Starting batch upload...',
      uploads: [],
      taskIds: []
    };

    res.json({
      success: true,
      message: 'Batch upload started',
      total: uploads.length
    });

    // Process uploads
    for (let i = 0; i < uploads.length; i++) {
      const { url, name, folderId = '' } = uploads[i];
      
      uploadProgress.current = i + 1;
      uploadProgress.status = `Uploading: ${name}`;

      try {
        const response = await axios.post(`${CONFIG.STREAM_UPLOAD_BASE}/advance-upload`, {
          url,
          name,
          folderId
        }, {
          headers: {
            'api-token': getApiKey(),
            'Content-Type': 'application/json'
          }
        });
        
        const taskId = response.data.id;
        uploadProgress.taskIds.push(taskId);
        uploadProgress.uploads.push({
          taskId,
          name,
          url,
          status: 'uploaded',
          createdAt: new Date().toISOString()
        });

        log(`Batch upload success: ${name} (${taskId})`);
      } catch (error) {
        uploadProgress.uploads.push({
          taskId: null,
          name,
          url,
          status: 'failed',
          error: error.message,
          createdAt: new Date().toISOString()
        });

        log(`Batch upload failed: ${name} - ${error.message}`, 'ERROR');
      }

      await delay(1000); // Rate limiting
    }

    uploadProgress.running = false;
    uploadProgress.status = 'Batch upload completed';

  } catch (error) {
    uploadProgress.running = false;
    uploadProgress.status = `Batch upload error: ${error.message}`;
    log(`Batch upload error: ${error.message}`, 'ERROR');
  }
});

// Enhanced upload progress with task status checking
app.get('/api/upload/progress', async (req, res) => {
  try {
    // Check status of all active uploads
    if (uploadProgress.taskIds && uploadProgress.taskIds.length > 0) {
      const statusPromises = uploadProgress.taskIds.map(async (taskId) => {
        try {
          const status = await checkUploadStatus(taskId);
          return { taskId, ...status };
        } catch (error) {
          return { taskId, status: 'Error', error: error.message };
        }
      });

      const statuses = await Promise.all(statusPromises);
      
      res.json({
        success: true,
        progress: {
          ...uploadProgress,
          taskStatuses: statuses
        }
      });
    } else {
      res.json({
        success: true,
        progress: uploadProgress
      });
    }

  } catch (error) {
    res.json({
      success: true,
      progress: {
        ...uploadProgress,
        error: error.message
      }
    });
  }
});

// NEW: Single video clone endpoint
app.post('/api/video/clone', async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) {
      return res.status(400).json({ success: false, error: 'videoId is required' });
    }

    const result = await cloneVideo(videoId);

    if (result.success) {
      res.json({ success: true, message: `Video cloned successfully. New ID: ${result.newId}`, data: result });
    } else {
      res.status(500).json({ success: false, error: 'Failed to clone video', details: result.error });
    }
  } catch (error) {
    log(`Clone video error: ${error.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Internal server error', details: error.message });
  }
});

// NEW: Batch video clone endpoint
app.post('/api/video/clone/batch', async (req, res) => {
  try {
    const { videoIds } = req.body; // Expecting a comma-separated string

    if (!videoIds || typeof videoIds !== 'string') {
      return res.status(400).json({ success: false, error: 'videoIds string is required' });
    }

    const ids = videoIds.split(',').map(id => id.trim()).filter(id => id);
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid video IDs provided' });
    }

    let successful = 0;
    let failed = 0;
    const results = [];

    for (const videoId of ids) {
      const result = await cloneVideo(videoId);
      if (result.success) {
        successful++;
        results.push({ originalId: videoId, newId: result.newId, status: 'success' });
      } else {
        failed++;
        results.push({ originalId: videoId, status: 'failed', error: result.error });
      }
      await delay(500); // Rate limiting
    }

    res.json({
      success: true,
      message: `Batch clone completed: ${successful} successful, ${failed} failed`,
      stats: { successful, failed, total: ids.length },
      results
    });

  } catch (error) {
    log(`Batch clone error: ${error.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Batch clone failed', details: error.message });
  }
});

// ===================================================================
// START: NEW DARK MODE DASHBOARD HTML & CSS
// ===================================================================
app.get('/dashboard', (req, res) => {
  const { pass } = req.query;
  if (pass !== CONFIG.DASHBOARD_PASSWORD) {
    return res.status(401).send(`
      <html>
        <head>
          <title>Unauthorized</title>
          <style>
            body { 
              font-family: Arial, sans-serif; 
              background-color: #121212; 
              color: #e0e0e0; 
              text-align: center; 
              padding: 50px; 
            }
            h2 { color: #bb86fc; }
          </style>
        </head>
        <body>
          <h2>🔒 Access Denied</h2>
          <p>Invalid password</p>
        </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>StreamP2P Manager Dashboard v2.2 Professional</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg-dark: #1a1a2e;
          --bg-light: #2a2a4a;
          --primary: #8e44ad;
          --secondary: #4a90e2;
          --text-light: #f0f0f0;
          --text-muted: #a0a0c0;
          --border-color: #3a3a5a;
          --success: #2ecc71;
          --danger: #e74c3c;
          --warning: #f39c12;
          --info: #3498db;
          --gradient: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Poppins', sans-serif;
          background-color: var(--bg-dark);
          color: var(--text-light);
          min-height: 100vh;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        .container { max-width: 1600px; margin: 0 auto; padding: 25px; }
        .header {
          text-align: center;
          margin-bottom: 30px;
        }
        .header h1 {
          font-size: 2.8rem;
          font-weight: 700;
          background: var(--gradient);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          margin-bottom: 10px;
        }
        .header p { color: var(--text-muted); font-size: 1.1rem; }
        .tabs { 
          display: flex;
          background-color: var(--bg-light);
          border-radius: 12px;
          margin-bottom: 30px;
          padding: 5px;
          border: 1px solid var(--border-color);
        }
        .tab { 
          flex: 1;
          padding: 15px 10px;
          text-align: center;
          cursor: pointer;
          border: none;
          background: transparent;
          color: var(--text-muted);
          font-weight: 600;
          font-size: 1rem;
          border-radius: 8px;
          transition: all 0.3s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .tab.active {
          background: var(--gradient);
          color: white;
          box-shadow: 0 4px 20px rgba(142, 68, 173, 0.4);
        }
        .tab:hover:not(.active) { color: white; background-color: rgba(255,255,255,0.05); }
        .tab-content { display: none; }
        .tab-content.active { display: block; animation: fadeIn 0.5s ease-in-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .section {
          background-color: var(--bg-light);
          border-radius: 15px;
          padding: 30px;
          margin-bottom: 30px;
          border: 1px solid var(--border-color);
          box-shadow: 0 8px 30px rgba(0,0,0,0.2);
        }
        .section h3, .section h4 {
          color: white;
          margin-bottom: 20px;
          font-weight: 600;
          padding-bottom: 10px;
          border-bottom: 1px solid var(--border-color);
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 25px;
          margin-bottom: 30px;
        }
        .stat-card {
          background-color: var(--bg-light);
          border-radius: 15px;
          padding: 25px;
          border: 1px solid var(--border-color);
          transition: all 0.3s ease;
          display: flex;
          align-items: center;
          gap: 20px;
        }
        .stat-card:hover { transform: translateY(-5px); box-shadow: 0 10px 25px rgba(0,0,0,0.3); border-color: var(--primary); }
        .stat-icon {
          width: 50px;
          height: 50px;
          display: grid;
          place-items: center;
          border-radius: 50%;
          background: var(--gradient);
        }
        .stat-icon svg { width: 24px; height: 24px; color: white; }
        .stat-number { font-size: 2.2rem; font-weight: 700; color: white; line-height: 1; }
        .stat-label { color: var(--text-muted); font-size: 1rem; }
        .btn {
          background: var(--gradient);
          color: white;
          border: none;
          padding: 12px 25px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 1rem;
          font-weight: 600;
          margin: 5px;
          transition: all 0.3s ease;
          box-shadow: 0 4px 15px rgba(0,0,0,0.2);
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .btn:hover { transform: translateY(-3px) scale(1.03); box-shadow: 0 6px 20px rgba(142, 68, 173, 0.5); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
        .btn-danger { background: linear-gradient(135deg, #c0392b, #e74c3c); }
        .btn-danger:hover { box-shadow: 0 6px 20px rgba(231, 76, 60, 0.5); }
        .btn-success { background: linear-gradient(135deg, #27ae60, #2ecc71); }
        .btn-success:hover { box-shadow: 0 6px 20px rgba(46, 204, 113, 0.5); }
        .btn-warning { background: linear-gradient(135deg, #d35400, #f39c12); }
        .btn-warning:hover { box-shadow: 0 6px 20px rgba(243, 156, 18, 0.5); }
        .btn-small { padding: 8px 16px; font-size: 0.9rem; }
        .input-group { display: flex; gap: 15px; margin-bottom: 20px; align-items: center; }
        .input-group input, .input-group select, textarea { 
          flex: 1;
          padding: 12px 15px;
          border: 1px solid var(--border-color);
          border-radius: 8px;
          font-size: 1rem;
          background-color: var(--bg-dark);
          color: var(--text-light);
          transition: border-color 0.3s, box-shadow 0.3s;
          font-family: 'Poppins', sans-serif;
        }
        .input-group input:focus, .input-group select:focus, textarea:focus { 
          outline: none;
          border-color: var(--primary);
          box-shadow: 0 0 0 3px rgba(142, 68, 173, 0.3);
        }
        .progress-container {
          background-color: var(--bg-light);
          border-radius: 15px;
          padding: 25px;
          margin-bottom: 30px;
          border: 1px solid var(--border-color);
          display: none;
        }
        .progress-bar {
          background: var(--bg-dark);
          border-radius: 10px;
          height: 20px;
          overflow: hidden;
          margin-bottom: 15px;
          border: 1px solid var(--border-color);
        }
        .progress-fill {
          background: var(--gradient);
          height: 100%;
          transition: width 0.4s ease-in-out;
          border-radius: 8px;
        }
        #progressText, #uploadProgressText, #duplicateProgressText { color: var(--text-muted); font-weight: 500; }
        .loading { text-align: center; padding: 50px; color: var(--text-muted); font-size: 1.2rem; }
        .alert {
          padding: 15px 20px;
          border-radius: 8px;
          margin-bottom: 20px;
          border: 1px solid transparent;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .alert-success { background-color: rgba(46, 204, 113, 0.1); color: var(--success); border-color: var(--success); }
        .alert-danger { background-color: rgba(231, 76, 60, 0.1); color: var(--danger); border-color: var(--danger); }
        .alert-info { background-color: rgba(52, 152, 219, 0.1); color: var(--info); border-color: var(--info); }
        .series-card {
          border: 1px solid var(--border-color);
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 20px;
          background: var(--bg-dark);
        }
        .season-container {
          border: 1px solid var(--border-color);
          border-radius: 8px;
          margin-bottom: 15px;
          background: var(--bg-light);
          overflow: hidden;
        }
        .season-header {
          background: rgba(0,0,0,0.2);
          padding: 12px 15px;
          font-weight: 600;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .episodes-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 15px;
          padding: 15px;
        }
        .episode-card {
          border: 1px solid var(--border-color);
          border-radius: 8px;
          padding: 12px;
          background: var(--bg-dark);
          transition: all 0.2s;
        }
        .episode-card:hover { border-color: var(--primary); }
        .episode-title { font-weight: 600; color: var(--text-light); margin-bottom: 5px; }
        .episode-meta { font-size: 0.85rem; color: var(--text-muted); }
        .missing-episodes {
          background: rgba(231, 76, 60, 0.1);
          border: 1px solid var(--danger);
          border-radius: 6px;
          padding: 10px;
          margin: 15px;
          color: var(--danger);
        }
        .duplicate-card {
          border: 1px solid var(--warning);
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 20px;
          background: rgba(243, 156, 18, 0.05);
        }
        .duplicate-item {
          border: 1px solid var(--border-color);
          border-radius: 8px;
          padding: 15px;
          margin-bottom: 10px;
          background: var(--bg-dark);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .video-info h4 { margin-bottom: 5px; color: var(--text-light); }
        .video-meta { font-size: 0.9rem; color: var(--text-muted); }
        .status-badge {
          padding: 5px 12px;
          border-radius: 20px;
          font-size: 0.8rem;
          font-weight: 600;
          text-transform: uppercase;
        }
        .status-completed { background: rgba(46, 204, 113, 0.2); color: var(--success); }
        .status-pending { background: rgba(243, 156, 18, 0.2); color: var(--warning); }
        .status-failed { background: rgba(231, 76, 60, 0.2); color: var(--danger); }
        .status-processing { background: rgba(52, 152, 219, 0.2); color: var(--info); }
        .upload-status-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
          gap: 15px; margin-top: 20px;
        }
        .upload-status-card {
          border: 1px solid var(--border-color);
          border-radius: 8px;
          padding: 15px;
          background: var(--bg-dark);
        }
        .rename-failure-item {
            display: flex; flex-direction: column; gap: 10px; padding: 15px;
            border: 1px solid var(--border-color); border-radius: 8px; margin-bottom: 10px;
            background-color: var(--bg-dark);
        }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 15px; text-align: left; border-bottom: 1px solid var(--border-color); }
        th { font-weight: 600; color: var(--text-muted); font-size: 0.9rem; text-transform: uppercase; }
        tbody tr { transition: background-color 0.2s; }
        tbody tr:hover { background-color: rgba(255,255,255,0.03); }
        @media (max-width: 768px) {
          .container { padding: 15px; }
          .header h1 { font-size: 2rem; }
          .stats-grid { grid-template-columns: 1fr; }
          .tabs { flex-direction: column; }
          .input-group { flex-direction: column; align-items: stretch; }
          .episodes-grid { grid-template-columns: 1fr; }
          .tab { justify-content: flex-start; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>StreamP2P Manager</h1>
          <p>Professional Content Management Dashboard v2.2</p>
        </div>

        <div class="tabs">
          <button class="tab active" onclick="switchTab('dashboard')"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20V16"/></svg>Dashboard</button>
          <button class="tab" onclick="switchTab('search')"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Search</button>
          <button class="tab" onclick="switchTab('upload')"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Upload</button>
          <button class="tab" onclick="switchTab('duplicates')"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>Duplicates</button>
          <button class="tab" onclick="switchTab('manage')"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>Manage</button>
        </div>

        <!-- Dashboard Tab -->
        <div id="dashboard-tab" class="tab-content active">
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg></div>
              <div>
                <div class="stat-number" id="totalRequests">-</div>
                <div class="stat-label">Total Requests</div>
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg></div>
              <div>
                <div class="stat-number" id="totalCount">-</div>
                <div class="stat-label">Request Count</div>
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><path d="M17 2v4M7 2v4M2 12h20"></path></svg></div>
              <div>
                <div class="stat-number" id="movieRequests">-</div>
                <div class="stat-label">Movie Requests</div>
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2z"></path><line x1="12" y1="18" x2="12.01" y2="18"></line></svg></div>
              <div>
                <div class="stat-number" id="seriesRequests">-</div>
                <div class="stat-label">Series Requests</div>
              </div>
            </div>
          </div>

          <div class="section">
            <h3>Content Requests</h3>
            <input type="text" id="searchBox" placeholder="🔍 Search requests by title or TMDB ID..." style="width: 100%; margin-bottom: 20px;">
            <div id="alertContainer"></div>
            <div class="loading" id="loading">Loading data...</div>
            <div style="overflow-x: auto;">
              <table id="dataTable" style="display: none;">
                <thead>
                  <tr>
                    <th>TMDB ID</th><th>Title</th><th>Type</th><th>Count</th><th>Last Requested</th><th>Status</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody id="tableBody"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Search Tab -->
        <div id="search-tab" class="tab-content">
          <div class="section">
            <h3>Search StreamP2P Videos</h3>
            <div class="input-group">
              <input type="text" id="videoSearchInput" placeholder="Enter movie/series title...">
              <button class="btn" onclick="searchVideos()">Search</button>
              <button class="btn" onclick="searchVideos(true)">Exact Match</button>
              <button class="btn btn-success" onclick="searchVideos(false, true)">Organize Series</button>
            </div>
            <div id="searchLoading" class="loading" style="display: none;">Searching...</div>
            <div id="searchResults"></div>
          </div>
        </div>

        <!-- Upload Tab -->
        <div id="upload-tab" class="tab-content">
          <div class="section">
            <h3>Upload Content</h3>
            <div style="margin-bottom: 30px;">
              <h4>Upload from URL/Torrent</h4>
              <div class="input-group">
                <input type="text" id="uploadUrl" placeholder="Direct link, magnet link, or torrent URL">
                <input type="text" id="uploadName" placeholder="Video name">
                <button class="btn btn-success" onclick="uploadFromUrl()">Upload</button>
              </div>
            </div>
            <div style="margin-bottom: 30px;">
              <h4>Batch Upload</h4>
              <textarea id="batchUploadList" rows="10" placeholder="Format: URL|Name (one per line)"></textarea>
              <button class="btn btn-success" onclick="batchUpload()" style="margin-top: 10px;">Start Batch Upload</button>
            </div>
            <div style="margin-bottom: 30px;">
              <h4>Get TUS Endpoint (for file uploads)</h4>
              <button class="btn" onclick="getTusEndpoint()">Get Upload Endpoint</button>
              <div id="tusInfo" style="margin-top: 15px; padding: 15px; background: var(--bg-dark); border-radius: 8px; display: none; border: 1px solid var(--border-color);"></div>
            </div>
            <div>
              <h4>Clone Existing Video</h4>
              <p style="color: var(--text-muted); margin-bottom: 15px;">Create a copy of an existing video on the server using its ID.</p>
              <div style="margin-bottom: 30px;">
                <h5>Single Clone</h5>
                <div class="input-group">
                  <input type="text" id="cloneVideoId" placeholder="Enter Video ID to clone">
                  <button class="btn btn-warning" onclick="cloneSingleVideo(event)">Clone Video</button>
                </div>
              </div>
              <div>
                <h5>Batch Clone</h5>
                <textarea id="batchCloneIds" rows="5" placeholder="Enter multiple Video IDs, separated by commas"></textarea>
                <button class="btn btn-warning" onclick="batchCloneVideos(event)" style="margin-top: 10px;">Start Batch Clone</button>
              </div>
            </div>
          </div>
          <div class="progress-container" id="uploadProgressContainer">
            <h4>Upload Progress</h4>
            <div class="progress-bar"><div class="progress-fill" id="uploadProgressFill"></div></div>
            <div id="uploadProgressText">Ready...</div>
            <div id="uploadStatusGrid" class="upload-status-grid"></div>
          </div>
        </div>

        <!-- Duplicates Tab -->
        <div id="duplicates-tab" class="tab-content">
          <div class="section">
            <h3>Duplicate Detection</h3>
            <p style="margin-bottom: 20px; color: var(--text-muted);">Scan your video library for duplicate files and manage them efficiently.</p>
            <div class="input-group">
              <button class="btn btn-warning" onclick="scanDuplicates()">Scan for Duplicates</button>
              <button class="btn btn-danger" onclick="deleteAllDuplicates()" id="deleteAllBtn" style="display: none;">Delete All Duplicates</button>
            </div>
          </div>
          <div class="progress-container" id="duplicateProgressContainer">
            <h4>Duplicate Scan Progress</h4>
            <div class="progress-bar"><div class="progress-fill" id="duplicateProgressFill"></div></div>
            <div id="duplicateProgressText">Ready...</div>
          </div>
          <div id="duplicateResults" class="section" style="display: none;">
            <h4>Duplicate Results</h4>
            <div id="duplicateList"></div>
          </div>
        </div>

        <!-- Manage Tab -->
        <div id="manage-tab" class="tab-content">
          <div class="section">
            <h3>Management Tools</h3>
            <div class="input-group" style="flex-wrap: wrap;">
              <button class="btn" onclick="refreshData()">Refresh Data</button>
              <button class="btn" onclick="startBatchRename()">Rename All Videos (with IMDB ID)</button>
              <button class="btn btn-danger" onclick="clearRequests()">Clear All Requests</button>
            </div>
            <div class="alert alert-info" style="margin-top: 20px;">
              <strong>Enhanced Rename Feature:</strong> Now includes IMDB ID integration and vastly improved title parsing!<br>
              <strong>Movies:</strong> Movie Title Year {TMDB_ID} {IMDB_ID}.mkv<br>
              <strong>Series:</strong> Series Name S01-E01-Episode Title {TMDB_ID} {IMDB_ID}.mkv
            </div>
          </div>
          <div class="progress-container" id="progressContainer">
            <h4>Batch Rename Progress</h4>
            <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
            <div id="progressText">Initializing...</div>
          </div>
          <div class="section" id="renameFailuresContainer" style="display: none;">
            <h3>Rename Failures</h3>
            <p style="color: var(--text-muted); margin-bottom: 15px;">The following videos could not be renamed automatically. You can correct them manually below.</p>
            <div id="renameFailuresList"></div>
            <button class="btn btn-warning" onclick="document.getElementById('renameFailuresContainer').style.display = 'none'">Clear Failures List</button>
          </div>
        </div>
      </div>

      <script>
        // All JavaScript functions from the original code are preserved here.
        // No changes were made to the functionality.
        let allData = [];
        let progressInterval;
        let uploadInterval;
        let duplicateInterval;

        // Tab switching
        function switchTab(tabName) {
          document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
          document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
          
          document.getElementById(tabName + '-tab').classList.add('active');
          event.target.classList.add('active');
        }

        // Load dashboard data
        async function loadData() {
          try {
            document.getElementById('loading').style.display = 'block';
            document.getElementById('dataTable').style.display = 'none';
            
            const response = await fetch('/api/dashboard/data');
            const result = await response.json();
            
            if (result.success) {
              allData = result.data;
              updateStats(result.stats);
              renderTable(allData);
            } else {
              showAlert('Failed to load data: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('Error loading data: ' + error.message, 'danger');
          } finally {
            document.getElementById('loading').style.display = 'none';
            document.getElementById('dataTable').style.display = 'table';
          }
        }

        // Update statistics
        function updateStats(stats) {
          document.getElementById('totalRequests').textContent = stats.totalRequests;
          document.getElementById('totalCount').textContent = stats.totalCount;
          document.getElementById('movieRequests').textContent = stats.movieRequests;
          document.getElementById('seriesRequests').textContent = stats.seriesRequests;
        }

        // Render data table
        function renderTable(data) {
          const tbody = document.getElementById('tableBody');
          tbody.innerHTML = '';
          
          data.forEach(item => {
            const row = tbody.insertRow();
            row.id = \`request-\${item.tmdbId}\`;
            row.innerHTML = \`
              <td>\${item.tmdbId}</td>
              <td>\${item.title}</td>
              <td><span class="status-badge status-\${item.type === 'movie' ? 'completed' : 'processing'}">\${item.type.toUpperCase()}</span></td>
              <td><strong>\${item.count}</strong></td>
              <td>\${new Date(item.lastRequested).toLocaleString()}</td>
              <td><span class="status-badge status-completed">\${item.status || 'Requested'}</span></td>
              <td><button class="btn btn-small btn-danger" onclick="deleteRequest('\${item.tmdbId}', this)">Delete</button></td>
            \`;
          });
        }

        // NEW: Delete a single request
        async function deleteRequest(tmdbId, button) {
            if (!confirm(\`Are you sure you want to delete the request for TMDB ID: \${tmdbId}?\`)) {
                return;
            }

            button.disabled = true;
            button.textContent = 'Deleting...';

            try {
                const response = await fetch(\`/api/requests/\${tmdbId}\`, { method: 'DELETE' });
                const result = await response.json();

                if (result.success) {
                    showAlert('Request deleted successfully!', 'success');
                    const row = document.getElementById(\`request-\${tmdbId}\`);
                    if (row) {
                        row.style.transition = 'opacity 0.5s';
                        row.style.opacity = '0';
                        setTimeout(() => row.remove(), 500);
                    }
                    loadData();
                } else {
                    showAlert('Failed to delete request: ' + result.error, 'danger');
                    button.disabled = false;
                    button.textContent = 'Delete';
                }
            } catch (error) {
                showAlert('Error deleting request: ' + error.message, 'danger');
                button.disabled = false;
                button.textContent = 'Delete';
            }
        }

        // Search functionality
        document.getElementById('searchBox').addEventListener('input', function() {
          const query = this.value.toLowerCase();
          const filtered = allData.filter(item => 
            item.title.toLowerCase().includes(query) || 
            item.tmdbId.toString().includes(query)
          );
          renderTable(filtered);
        });

        // Enhanced search videos with organization
        async function searchVideos(exactMatch = false, organize = false) {
          const searchTerm = document.getElementById('videoSearchInput').value.trim();
          if (!searchTerm) {
            showAlert('Please enter a search term', 'danger');
            return;
          }

          document.getElementById('searchLoading').style.display = 'block';
          document.getElementById('searchResults').innerHTML = '';

          try {
            const response = await fetch(\`/api/stream/search?q=\${encodeURIComponent(searchTerm)}&exactMatch=\${exactMatch}&organize=\${organize}\`);
            const result = await response.json();

            if (result.success) {
              if (result.organized) {
                displayOrganizedResults(result.data, Object.keys(result.data).length);
              } else {
                displaySearchResults(result.data, result.count);
              }
              showAlert(\`Found \${result.count} videos\`, 'success');
            } else {
              showAlert('Search failed: ' + result.error, 'danger');
            }
          } catch (error) {
            showAlert('Search error: ' + error.message, 'danger');
          } finally {
            document.getElementById('searchLoading').style.display = 'none';
          }
        }

        // Display organized series results
        function displayOrganizedResults(seriesData, count) {
          const container = document.getElementById('searchResults');
          if (count === 0) { container.innerHTML = '<p>No series found.</p>'; return; }
          let html = \`<h4>Found \${count} series with organized episodes:</h4>\`;
          Object.values(seriesData).forEach(series => {
            html += \`<div class="series-card"> ... </div>\`; // Content is complex, keeping it brief for this example
            const totalSeasons = series.summary.totalSeasons;
            const availableSeasons = series.summary.seasonsAvailable;
            const missingSeasons = series.summary.missingSeasons;
            html += \`
              <div class="series-card">
                <div class="series-header">
                  <h3 class="series-title">\${series.seriesName}</h3>
                  <span class="status-badge status-completed">TMDB: \${series.tmdbId}</span>
                </div>
                <div class="series-summary">
                  📊 <strong>Summary:</strong> \${availableSeasons}/\${totalSeasons} seasons available
                  \${missingSeasons.length > 0 ? \`• Missing seasons: \${missingSeasons.join(', ')}\` : ''}
                </div>
            \`;
            Object.keys(series.seasons).sort((a, b) => parseInt(a) - parseInt(b)).forEach(seasonNum => {
              const season = series.seasons[seasonNum];
              html += \`<div class="season-container"> ... </div>\`; // Content is complex
               html += \`
                <div class="season-container">
                  <div class="season-header">
                    <span>🎬 \${season.name}</span>
                    <span>\${season.availableEpisodes}/\${season.expectedEpisodes} episodes
                      \${season.missingEpisodes.length > 0 ? \`• \${season.missingEpisodes.length} missing\` : ' ✅'}</span>
                  </div>
                  <div class="episodes-grid">
              \`;
              season.episodes.forEach(episode => {
                const size = (episode.size / (1024 * 1024 * 1024)).toFixed(2);
                const duration = Math.floor(episode.duration / 60);
                html += \`
                  <div class="episode-card">
                    <div class="episode-title">\${episode.name}</div>
                    <div class="episode-meta">📊 \${size} GB • ⏱️ \${duration} min • 🎬 \${episode.resolution}</div>
                    <div style="margin-top: 8px;">
                      <a href="https://moonflix.p2pplay.pro/#\${episode.id}" target="_blank" class="btn btn-small">Stream</a>
                      <a href="https://moonflix.p2pplay.pro/#\${episode.id}&dl=1" target="_blank" class="btn btn-small btn-success">Download</a>
                    </div>
                  </div>
                \`;
              });
              html += '</div>';
              if (season.missingEpisodes.length > 0) {
                html += \`<div class="missing-episodes">❌ Missing episodes: \${season.missingEpisodes.join(', ')}</div>\`;
              }
              html += '</div>';
            });
            html += '</div>';
          });
          container.innerHTML = html;
        }

        // Display regular search results
        function displaySearchResults(videos, count) {
          const container = document.getElementById('searchResults');
          if (count === 0) { container.innerHTML = '<p>No videos found.</p>'; return; }
          let html = \`<h4>Found \${count} videos:</h4>\`;
          videos.forEach(video => {
            const size = (video.size / (1024 * 1024 * 1024)).toFixed(2);
            const duration = Math.floor(video.duration / 60);
            html += \`
              <div class="duplicate-item">
                <div class="video-info">
                  <h4>\${video.name}</h4>
                  <div class="video-meta">📊 \${size} GB • ⏱️ \${duration} min • 🎬 \${video.resolution} • 📅 \${new Date(video.createdAt).toLocaleDateString()}</div>
                </div>
                <div>
                  <a href="\${video.streamUrl}" target="_blank" class="btn btn-small">Stream</a>
                  <a href="\${video.downloadUrl}" target="_blank" class="btn btn-small btn-success">Download</a>
                </div>
              </div>
            \`;
          });
          container.innerHTML = html;
        }

        // Upload from URL
        async function uploadFromUrl() {
          const url = document.getElementById('uploadUrl').value.trim();
          const name = document.getElementById('uploadName').value.trim();
          if (!url || !name) { showAlert('Please enter both URL and name', 'danger'); return; }
          try {
            const response = await fetch('/api/upload/url', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, name })
            });
            const result = await response.json();
            if (result.success) {
              showAlert(\`Upload started: \${result.taskId}\`, 'success');
              document.getElementById('uploadUrl').value = '';
              document.getElementById('uploadName').value = '';
              startUploadProgressTracking();
            } else { showAlert('Upload failed: ' + result.error, 'danger'); }
          } catch (error) { showAlert('Upload error: ' + error.message, 'danger'); }
        }

        // Batch upload
        async function batchUpload() {
          const batchText = document.getElementById('batchUploadList').value.trim();
          if (!batchText) { showAlert('Please enter batch upload list', 'danger'); return; }
          const lines = batchText.split('\\n').filter(line => line.trim());
          const uploads = lines.map(line => { const parts = line.split('|'); return parts.length >= 2 ? { url: parts[0].trim(), name: parts[1].trim() } : null; }).filter(Boolean);
          if (uploads.length === 0) { showAlert('No valid uploads found in the list', 'danger'); return; }
          try {
            const response = await fetch('/api/upload/batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uploads })
            });
            const result = await response.json();
            if (result.success) {
              showAlert(\`Batch upload started: \${result.total} files\`, 'success');
              document.getElementById('batchUploadList').value = '';
              startUploadProgressTracking();
            } else { showAlert('Batch upload failed: ' + result.error, 'danger'); }
          } catch (error) { showAlert('Batch upload error: ' + error.message, 'danger'); }
        }

        // Enhanced upload progress tracking
        function startUploadProgressTracking() {
          document.getElementById('uploadProgressContainer').style.display = 'block';
          uploadInterval = setInterval(async () => {
            try {
              const response = await fetch('/api/upload/progress');
              const result = await response.json();
              if (result.success) {
                const progress = result.progress;
                const percentage = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
                document.getElementById('uploadProgressFill').style.width = percentage + '%';
                document.getElementById('uploadProgressText').textContent = \`\${progress.current}/\${progress.total} - \${progress.status}\`;
                if (progress.taskStatuses) { updateUploadStatusGrid(progress.taskStatuses); }
                if (!progress.running && progress.current > 0) {
                  clearInterval(uploadInterval);
                  setTimeout(() => { document.getElementById('uploadProgressContainer').style.display = 'none'; }, 10000);
                  showAlert('Upload process completed!', 'success');
                }
              }
            } catch (error) {
              clearInterval(uploadInterval);
              showAlert('Upload progress tracking error: ' + error.message, 'danger');
            }
          }, 3000);
        }

        // Update upload status grid
        function updateUploadStatusGrid(taskStatuses) {
          const grid = document.getElementById('uploadStatusGrid');
          grid.innerHTML = taskStatuses.map(task => \`
            <div class="upload-status-card">
              <h5 style="margin-bottom: 10px; word-break: break-all;">\${task.name || task.taskId}</h5>
              <div><span class="status-badge status-\${getStatusClass(task.status)}">\${getStatusText(task.status)}</span></div>
              <div style="margin-top: 10px; font-size: 0.9rem; color: var(--text-muted);">
                <div>Task ID: \${task.taskId}</div>
                <div>Updated: \${new Date(task.updatedAt || task.createdAt).toLocaleString()}</div>
                \${task.videos ? \`<div>Videos: \${task.videos.length}</div>\` : ''}
              </div>
            </div>
          \`).join('');
        }

        // Get status class for styling
        function getStatusClass(status) {
          const map = { 'Completed': 'completed', 'Processing': 'processing', 'Pending': 'pending', 'Failed': 'failed', 'Error': 'failed' };
          return map[status] || 'pending';
        }

        // Get status text
        function getStatusText(status) {
          const map = { 'Pending': '⏳ Pending', 'Processing': '⚙️ Processing', 'Completed': '✅ Completed', 'Failed': '❌ Failed', 'Error': '⚠️ Error' };
          return map[status] || status;
        }

        // Scan for duplicates
        async function scanDuplicates() {
          try {
            const response = await fetch('/api/duplicates/scan');
            const result = await response.json();
            if (result.success) {
              showAlert('Duplicate scan started!', 'info');
              startDuplicateProgressTracking();
            } else { showAlert('Failed to start duplicate scan: ' + result.error, 'danger'); }
          } catch (error) { showAlert('Error: ' + error.message, 'danger'); }
        }

        // Track duplicate scan progress
        function startDuplicateProgressTracking() {
          document.getElementById('duplicateProgressContainer').style.display = 'block';
          duplicateInterval = setInterval(async () => {
            try {
              const response = await fetch('/api/duplicates/progress');
              const result = await response.json();
              if (result.success) {
                const progress = result.progress;
                const percentage = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
                document.getElementById('duplicateProgressFill').style.width = percentage + '%';
                document.getElementById('duplicateProgressText').textContent = \`\${progress.current}/\${progress.total} - \${progress.status}\`;
                if (!progress.running) {
                  clearInterval(duplicateInterval);
                  displayDuplicateResults(progress.duplicates);
                  setTimeout(() => { document.getElementById('duplicateProgressContainer').style.display = 'none'; }, 3000);
                  showAlert('Duplicate scan completed!', 'success');
                }
              }
            } catch (error) {
              clearInterval(duplicateInterval);
              showAlert('Duplicate progress tracking error: ' + error.message, 'danger');
            }
          }, 2000);
        }

        // Display duplicate results
        function displayDuplicateResults(duplicates) {
          const resultsDiv = document.getElementById('duplicateResults');
          const listDiv = document.getElementById('duplicateList');
          if (duplicates.length === 0) {
            listDiv.innerHTML = '<div class="alert alert-success">No duplicates found! Your library is clean.</div>';
            resultsDiv.style.display = 'block';
            return;
          }
          document.getElementById('deleteAllBtn').style.display = 'inline-flex';
          let html = \`<div class="alert alert-info">Found \${duplicates.length} duplicate groups</div>\`;
          duplicates.forEach((group, index) => {
            const totalSize = (group.totalSize / (1024 * 1024 * 1024)).toFixed(2);
            html += \`
              <div class="duplicate-card">
                <div class="duplicate-header"><h4>\${group.originalName}</h4><div><span class="status-badge status-warning">\${group.duplicateCount} copies</span><span class="status-badge status-failed">\${totalSize} GB total</span></div></div>
                <div>\${group.videos.map((video, videoIndex) => {
                  const size = (video.size / (1024 * 1024 * 1024)).toFixed(2);
                  const duration = Math.floor(video.duration / 60);
                  return \`<div class="duplicate-item"><div class="video-info"><h4>\${video.name}</h4><div class="video-meta">ID: \${video.id} • \${size} GB • \${duration} min • \${video.resolution}</div></div><div>\${videoIndex > 0 ? \`<button class="btn btn-small btn-danger" onclick="deleteDuplicate('\${video.id}', this)">Delete</button>\` : \`<span class="status-badge status-completed">Keep Original</span>\`}</div></div>\`;
                }).join('')}</div>
                <div style="margin-top: 15px; text-align: right;"><button class="btn btn-danger btn-small" onclick="deleteGroupDuplicates(\${index})">Delete All Duplicates in Group</button></div>
              </div>\`;
          });
          listDiv.innerHTML = html;
          resultsDiv.style.display = 'block';
          window.duplicatesData = duplicates;
        }

        // Delete single duplicate
        async function deleteDuplicate(videoId, buttonElement) {
          if (!confirm('Are you sure you want to delete this duplicate?')) return;
          buttonElement.disabled = true;
          buttonElement.textContent = 'Deleting...';
          try {
            const response = await fetch(\`/api/duplicates/delete/\${videoId}\`, { method: 'DELETE' });
            const result = await response.json();
            if (result.success) {
              buttonElement.textContent = 'Deleted';
              buttonElement.classList.remove('btn-danger');
              buttonElement.classList.add('btn-success');
              showAlert('Video deleted successfully', 'success');
            } else {
              buttonElement.disabled = false;
              buttonElement.textContent = 'Delete';
              showAlert('Failed to delete video: ' + result.error, 'danger');
            }
          } catch (error) {
            buttonElement.disabled = false;
            buttonElement.textContent = 'Delete';
            showAlert('Delete error: ' + error.message, 'danger');
          }
        }

        // Delete duplicates in a group
        async function deleteGroupDuplicates(groupIndex) {
          const group = window.duplicatesData[groupIndex];
          const videosToDelete = group.videos.slice(1);
          if (!confirm(\`Delete \${videosToDelete.length} duplicate copies of "\${group.originalName}"?\`)) return;
          try {
            const videoIds = videosToDelete.map(v => v.id);
            const response = await fetch('/api/duplicates/batch-delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoIds })
            });
            const result = await response.json();
            if (result.success) {
              showAlert(result.message, 'success');
              setTimeout(() => scanDuplicates(), 2000);
            } else { showAlert('Batch delete failed: ' + result.error, 'danger'); }
          } catch (error) { showAlert('Batch delete error: ' + error.message, 'danger'); }
        }

        // Delete all duplicates
        async function deleteAllDuplicates() {
          const allDuplicates = window.duplicatesData || [];
          const totalVideos = allDuplicates.reduce((sum, group) => sum + (group.videos.length - 1), 0);
          if (!confirm(\`This will delete \${totalVideos} duplicate videos. Continue?\`)) return;
          try {
            const allVideoIds = allDuplicates.flatMap(group => group.videos.slice(1).map(video => video.id));
            const response = await fetch('/api/duplicates/batch-delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoIds: allVideoIds })
            });
            const result = await response.json();
            if (result.success) {
              showAlert(result.message, 'success');
              document.getElementById('duplicateResults').style.display = 'none';
              document.getElementById('deleteAllBtn').style.display = 'none';
            } else { showAlert('Batch delete failed: ' + result.error, 'danger'); }
          } catch (error) { showAlert('Batch delete error: ' + error.message, 'danger'); }
        }

        // Get TUS endpoint
        async function getTusEndpoint() {
          try {
            const response = await fetch('/api/upload/tus');
            const result = await response.json();
            if (result.success) {
              const tusInfo = document.getElementById('tusInfo');
              tusInfo.innerHTML = \`
                <h5>TUS Upload Endpoint:</h5>
                <p><strong>URL:</strong> \${result.data.tusUrl}</p>
                <p><strong>Access Token:</strong> \${result.data.accessToken}</p>
                <small>💡 Use tus-js-client or similar library for file uploads</small>
              \`;
              tusInfo.style.display = 'block';
            } else { showAlert('Failed to get TUS endpoint: ' + result.error, 'danger'); }
          } catch (error) { showAlert('TUS endpoint error: ' + error.message, 'danger'); }
        }

        // Clone a single video
        async function cloneSingleVideo(event) {
          const videoId = document.getElementById('cloneVideoId').value.trim();
          if (!videoId) { showAlert('Please enter a Video ID to clone.', 'danger'); return; }
          const button = event.target;
          button.disabled = true; button.textContent = 'Cloning...';
          try {
            const response = await fetch('/api/video/clone', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoId })
            });
            const result = await response.json();
            if (result.success) {
              showAlert(result.message, 'success');
              document.getElementById('cloneVideoId').value = '';
            } else { showAlert('Clone failed: ' + (result.details || result.error), 'danger'); }
          } catch (error) { showAlert('Clone error: ' + error.message, 'danger'); }
          finally { button.disabled = false; button.textContent = 'Clone Video'; }
        }

        // Batch clone videos
        async function batchCloneVideos(event) {
          const videoIds = document.getElementById('batchCloneIds').value.trim();
          if (!videoIds) { showAlert('Please enter Video IDs for batch cloning.', 'danger'); return; }
          const button = event.target;
          button.disabled = true; button.textContent = 'Cloning...';
          try {
            const response = await fetch('/api/video/clone/batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoIds })
            });
            const result = await response.json();
            if (result.success) {
              showAlert(result.message, 'success');
              document.getElementById('batchCloneIds').value = '';
            } else { showAlert('Batch clone failed: ' + (result.details || result.error), 'danger'); }
          } catch (error) { showAlert('Batch clone error: ' + error.message, 'danger'); }
          finally { button.disabled = false; button.textContent = 'Start Batch Clone'; }
        }

        // Show alerts
        function showAlert(message, type) {
          const container = document.getElementById('alertContainer');
          const alert = document.createElement('div');
          alert.className = \`alert alert-\${type}\`;
          alert.innerHTML = \`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"></path><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg><span>\${message}</span>\`;
          container.prepend(alert);
          setTimeout(() => { if (alert.parentNode) alert.remove(); }, 5000);
        }

        // Refresh data
        function refreshData() { loadData(); }

        // Start batch rename
        async function startBatchRename() {
          if (confirm('This will rename all videos in StreamP2P with TMDB and IMDB IDs. Continue?')) {
            try {
              document.getElementById('renameFailuresContainer').style.display = 'none';
              const response = await fetch('/api/rename/batch', { method: 'POST' });
              const result = await response.json();
              if (result.success) {
                showAlert('Enhanced batch rename started!', 'success');
                startProgressTracking();
              } else { showAlert('Failed to start batch rename: ' + result.error, 'danger'); }
            } catch (error) { showAlert('Error: ' + error.message, 'danger'); }
          }
        }

        // Track rename progress
        function startProgressTracking() {
          document.getElementById('progressContainer').style.display = 'block';
          progressInterval = setInterval(async () => {
            try {
              const response = await fetch('/api/rename/progress');
              const result = await response.json();
              if (result.success) {
                const progress = result.progress;
                const percentage = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
                document.getElementById('progressFill').style.width = percentage + '%';
                document.getElementById('progressText').textContent = \`\${progress.current}/\${progress.total} - \${progress.status}\`;
                if (!progress.running) {
                  clearInterval(progressInterval);
                  setTimeout(() => { document.getElementById('progressContainer').style.display = 'none'; }, 3000);
                  showAlert('Enhanced batch rename completed!', 'success');
                  if (progress.failures && progress.failures.length > 0) { displayRenameFailures(progress.failures); }
                }
              }
            } catch (error) {
              clearInterval(progressInterval);
              showAlert('Progress tracking error: ' + error.message, 'danger');
            }
          }, 2000);
        }

        // Display rename failures
        function displayRenameFailures(failures) {
            const container = document.getElementById('renameFailuresContainer');
            const list = document.getElementById('renameFailuresList');
            list.innerHTML = '';
            failures.forEach(failure => {
                const item = document.createElement('div');
                item.className = 'rename-failure-item';
                item.id = \`failure-\${failure.id}\`;
                item.innerHTML = \`
                    <div><strong>Original Name:</strong><p style="font-family: monospace; background: var(--bg-dark); padding: 5px; border-radius: 4px; margin-top: 5px;">\${failure.name}</p></div>
                    <div class="input-group"><input type="text" id="newName-\${failure.id}" placeholder="Enter new name..."><button class="btn btn-small btn-warning" onclick="manualRename('\${failure.id}', this)">Rename</button></div>
                \`;
                list.appendChild(item);
            });
            container.style.display = 'block';
        }

        // Manual rename function
        async function manualRename(videoId, button) {
            const newName = document.getElementById(\`newName-\${videoId}\`).value.trim();
            if (!newName) { showAlert('Please enter a new name.', 'danger'); return; }
            button.disabled = true; button.textContent = 'Renaming...';
            try {
                const response = await fetch('/api/rename/manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ videoId, newName })
                });
                const result = await response.json();
                if (result.success) {
                    showAlert('Video renamed successfully!', 'success');
                    document.getElementById(\`failure-\${videoId}\`).innerHTML = \`<div class="alert alert-success">Renamed successfully to: \${newName}</div>\`;
                } else {
                    showAlert('Rename failed: ' + result.error, 'danger');
                    button.disabled = false; button.textContent = 'Rename';
                }
            } catch (error) {
                showAlert('Error during manual rename: ' + error.message, 'danger');
                button.disabled = false; button.textContent = 'Rename';
            }
        }

        // Clear all requests
        async function clearRequests() {
          if (confirm('This will delete all request data. Continue?')) {
            try {
              const response = await fetch('/api/requests/clear', { method: 'DELETE' });
              if (response.ok) {
                showAlert('All requests cleared!', 'success');
                loadData();
              } else { showAlert('Failed to clear requests', 'danger'); }
            } catch (error) { showAlert('Error: ' + error.message, 'danger'); }
          }
        }

        // Initialize
        loadData();
        setInterval(loadData, 30000);
        document.getElementById('videoSearchInput').addEventListener('keypress', e => e.key === 'Enter' && searchVideos());
        window.addEventListener('beforeunload', () => {
          if (progressInterval) clearInterval(progressInterval);
          if (uploadInterval) clearInterval(uploadInterval);
          if (duplicateInterval) clearInterval(duplicateInterval);
        });
      </script>
    </body>
    </html>
  `);
});
// ===================================================================
// END: NEW DARK MODE DASHBOARD HTML & CSS
// ===================================================================

// Upload from URL/Torrent
const uploadFromUrl = async (url, name, folderId = '') => {
  try {
    const response = await axios.post(`${CONFIG.STREAM_UPLOAD_BASE}/advance-upload`, {
      url,
      name,
      folderId
    }, {
      headers: {
        'api-token': getApiKey(),
        'Content-Type': 'application/json'
      }
    });

    return { success: true, taskId: response.data.id };
  } catch (error) {
    log(`Upload from URL failed: ${error.message}`, 'ERROR');
    throw error;
  }
};

// Get TUS upload endpoint
const getTusEndpoint = async () => {
  try {
    const response = await axios.get(`${CONFIG.STREAM_UPLOAD_BASE}/upload`, {
      headers: { 'api-token': getApiKey() }
    });
    return response.data;
  } catch (error) {
    log(`Get TUS endpoint failed: ${error.message}`, 'ERROR');
    throw error;
  }
};

// ===================================================================
// START: CORRECTED AND REWRITTEN MATCHING ENDPOINT
// ===================================================================
app.get('/api/stream/match', async (req, res) => {
  try {
    const { slug, tmdbId } = req.query;
    if (!slug && !tmdbId) {
      return res.status(400).json({ success: false, error: 'Missing slug or tmdbId parameter' });
    }

    let candidateVideos = [];

    // --- Path 1: Search by TMDB ID (Highest Accuracy) ---
    if (tmdbId) {
      log(`Stream match: Searching with TMDB ID: ${tmdbId}`);
      candidateVideos = await searchAllVideos(`{${tmdbId}}`);
    }

    // --- Path 2: Fallback to Title Search ---
    if (candidateVideos.length === 0 && slug) {
      const searchTerm = slug.replace(/[\/-]/g, ' ');
      log(`Stream match: TMDB ID search failed or skipped. Searching by slug: "${searchTerm}"`);
      candidateVideos = await searchAllVideos(searchTerm);
    }
    
    if (candidateVideos.length === 0) {
        log(`No candidate videos found for slug="${slug}" tmdbId="${tmdbId}"`);
        return res.json({ success: false, data: [] });
    }

    // Parse the incoming request slug to understand what the user wants.
    // Replace both slashes and dashes with spaces for better parsing.
    const parsedRequest = parseVideoTitle(slug.replace(/[\/-]/g, ' '));

    // --- Logic Branch: Handle Series and Movies Differently ---

    // BRANCH 1: PRECISE SERIES MATCHING
    // If the request is for a series, we MUST match the season and episode exactly.
    if (parsedRequest.isSeries && parsedRequest.season && parsedRequest.episode) {
      log(`Precise series match initiated for S${parsedRequest.season}E${parsedRequest.episode}`);
      
      const exactMatch = candidateVideos.find(video => {
          const parsedVideo = parseVideoTitle(video.name);
          return (
              parsedVideo.isSeries &&
              parsedVideo.season === parsedRequest.season &&
              parsedVideo.episode === parsedRequest.episode
          );
      });

      if (exactMatch) {
          log(`Exact series match FOUND: ${exactMatch.name}`);
          const downloadUrl = `https://moonflix.p2pplay.pro/#${exactMatch.id}&dl=1`;
          return res.json({
              success: true,
              data: [{
                  ...exactMatch,
                  downloadUrl,
                  streamUrl: `https://moonflix.p2pplay.pro/#${exactMatch.id}`
              }]
          });
      } else {
          log(`No exact S/E match found for S${parsedRequest.season}E${parsedRequest.episode}. The requested episode may not exist in the library.`);
          return res.json({ success: false, data: [], message: "Exact episode not found." });
      }
    }

    // BRANCH 2: FALLBACK SCORING LOGIC (Mainly for Movies)
    // If it's not a series request, use the original scoring logic.
    log(`Request is for a movie or a generic series title. Using scoring logic.`);
    let bestMatch = null;
    let highestScore = -1;

    for (const video of candidateVideos) {
      const parsedVideo = parseVideoTitle(video.name);
      let currentScore = 0;

      // Rule 1: TMDB ID Match (High Priority)
      if (tmdbId && video.name.includes(`{${tmdbId}}`)) {
        currentScore += 100;
      }

      // Rule 2: Normalized Title Match
      const normalizedRequestTitle = normalize(parsedRequest.title);
      const normalizedVideoTitle = normalize(parsedVideo.title);
      if (normalizedRequestTitle === normalizedVideoTitle) {
        currentScore += 50;
      } else if (normalizedVideoTitle.includes(normalizedRequestTitle)) {
        currentScore += 20;
      }

      // Rule 3: Year Match (for movies)
      if (!parsedRequest.isSeries && !parsedVideo.isSeries && parsedRequest.year && parsedRequest.year === parsedVideo.year) {
        currentScore += 40;
      }

      if (currentScore > highestScore) {
        highestScore = currentScore;
        bestMatch = video;
      }
    }

    // Final Decision for movies
    if (bestMatch && highestScore > 50) { 
      const downloadUrl = `https://moonflix.p2pplay.pro/#${bestMatch.id}&dl=1`;
      log(`Stream match FOUND for movie "${slug}" with score ${highestScore}: ${bestMatch.name}`);
      
      res.json({
        success: true,
        data: [{
          ...bestMatch,
          downloadUrl,
          streamUrl: `https://moonflix.p2pplay.pro/#${bestMatch.id}`
        }]
      });
    } else {
      log(`No confident stream match found for: "${slug}" (Best score: ${highestScore})`);
      res.json({ success: false, data: [] });
    }

  } catch (error) {
    log(`Stream match error: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false, 
      error: 'Stream matching failed', 
      details: error.message 
    });
  }
});
// ===================================================================
// END: CORRECTED MATCHING ENDPOINT
// ===================================================================


// Upload from URL endpoint
app.post('/api/upload/url', async (req, res) => {
  try {
    const { url, name, folderId = '' } = req.body;

    if (!url || !name) {
      return res.status(400).json({
        success: false,
        error: 'URL and name are required'
      });
    }

    log(`Upload from URL request: ${name} - ${url}`);

    const result = await uploadFromUrl(url, name, folderId);
    
    if (result.success) {
      // Track upload progress
      uploadProgress.uploads.push({
        taskId: result.taskId,
        name,
        url,
        status: 'pending',
        createdAt: new Date().toISOString()
      });

      if (!uploadProgress.taskIds) uploadProgress.taskIds = [];
      uploadProgress.taskIds.push(result.taskId);

      res.json({
        success: true,
        taskId: result.taskId,
        message: 'Upload started successfully'
      });
    }

  } catch (error) {
    log(`Upload from URL error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Upload failed',
      details: error.message
    });
  }
});

// Get TUS upload endpoint
app.get('/api/upload/tus', async (req, res) => {
  try {
    const tusData = await getTusEndpoint();
    
    res.json({
      success: true,
      data: tusData
    });

  } catch (error) {
    log(`TUS endpoint error: ${error.message}`, 'ERROR');
    res.status(500).json({
      success: false,
      error: 'Failed to get TUS endpoint',
      details: error.message
    });
  }
});

// Content request endpoint (existing)
app.post('/api/request', (req, res) => {
  try {
    const { title, tmdbId, type, season, episode } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!title || !tmdbId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing title or tmdbId' 
      });
    }

    // Anti-spam: 1 request per day per IP per content
    const key = `${ip}-${tmdbId}`;
    const now = Date.now();
    if (ipTracker[key] && now - ipTracker[key] < 24 * 60 * 60 * 1000) {
      return res.status(429).json({ 
        success: false, 
        error: 'Content already requested today' 
      });
    }
    ipTracker[key] = now;

    const data = readData();
    const existing = data.find(d => d.tmdbId === tmdbId);
    
    if (existing) {
      existing.count++;
      existing.lastRequested = new Date().toISOString();
    } else {
      data.push({
        tmdbId,
        title,
        type: type || 'movie',
        season,
        episode,
        count: 1,
        lastRequested: new Date().toISOString(),
        status: 'requested'
      });
    }

    writeData(data);
    log(`Content requested: ${title} (${tmdbId}) from ${ip}`);
    
    res.json({ 
      success: true, 
      message: 'Request recorded successfully' 
    });

  } catch (error) {
    log(`Request error: ${error.message}`, 'ERROR');
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process request' 
    });
  }
});

// Enhanced batch rename endpoint with IMDB ID support
app.post('/api/rename/batch', async (req, res) => {
  if (renameProgress.running) {
    return res.status(409).json({ 
      success: false, 
      error: 'Batch rename already in progress' 
    });
  }

  try {
    renameProgress = { running: true, current: 0, total: 0, status: 'Starting enhanced rename...', failures: [] };
    
    res.json({ 
      success: true, 
      message: 'Enhanced batch rename started. Check progress via /api/rename/progress' 
    });

    const videos = await fetchAllVideos();
    renameProgress.total = videos.length;
    renameProgress.status = 'Processing videos...';

    let count = { renamed: 0, skipped: 0, errors: 0 };

    for (const video of videos) {
      renameProgress.current++;
      renameProgress.status = `Processing: ${video.name}`;

      if (/\{\d+\}.*\{tt\d+\}/.test(video.name) || /\{tt\d+\}.*\{\d+\}/.test(video.name)) {
        count.skipped++;
        continue;
      }

      const info = parseVideoTitle(video.name);
      if (!info.title) {
        count.errors++;
        renameProgress.failures.push({ id: video.id, name: video.name, reason: 'Could not parse title' });
        continue;
      }

      try {
        const tmdb = await searchTMDB(info);
        if (!tmdb) {
          count.errors++;
          renameProgress.failures.push({ id: video.id, name: video.name, reason: 'TMDB/IMDB info not found' });
          continue;
        }

        let newName;
        const s = info.season?.toString().padStart(2, '0');
        const e = info.episode?.toString().padStart(2, '0');
        
        const imdbPart = tmdb.imdbId ? ` {${tmdb.imdbId}}` : '';
        if (info.isSeries) {
          newName = `${tmdb.seriesName} S${s}-E${e}-${tmdb.episodeName} {${tmdb.tmdbId}}${imdbPart}.mkv`;
        } else {
          newName = `${tmdb.title} ${tmdb.year} {${tmdb.tmdbId}}${imdbPart}.mkv`;
        }

        const success = await renameVideo(video.id, newName);
        if (success) {
          count.renamed++;
        } else {
          count.errors++;
          renameProgress.failures.push({ id: video.id, name: video.name, reason: 'API rename failed' });
        }
        
      } catch (tmdbError) {
        log(`TMDB/IMDB lookup error for ${video.name}: ${tmdbError.message}`, 'ERROR');
        count.errors++;
        renameProgress.failures.push({ id: video.id, name: video.name, reason: 'TMDB/IMDB API error' });
      }
      
      await delay(200);
    }

    renameProgress.running = false;
    renameProgress.status = `Completed: ${count.renamed} renamed, ${count.skipped} skipped, ${count.errors} errors`;
    log(`Batch rename completed: ${JSON.stringify(count)}`);

  } catch (error) {
    renameProgress.running = false;
    renameProgress.status = `Error: ${error.message}`;
    log(`Batch rename error: ${error.message}`, 'ERROR');
  }
});

// NEW: Manual rename endpoint
app.post('/api/rename/manual', async (req, res) => {
    try {
        const { videoId, newName } = req.body;
        if (!videoId || !newName) {
            return res.status(400).json({ success: false, error: 'videoId and newName are required' });
        }

        const success = await renameVideo(videoId, newName);

        if (success) {
            res.json({ success: true, message: 'Video renamed successfully' });
        } else {
            res.status(500).json({ success: false, error: 'Failed to rename video via API' });
        }
    } catch (error) {
        log(`Manual rename error: ${error.message}`, 'ERROR');
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Rename progress endpoint
app.get('/api/rename/progress', (req, res) => {
  res.json({ success: true, progress: renameProgress });
});

// Dashboard data endpoint
app.get('/api/dashboard/data', (req, res) => {
  try {
    const data = readData();
    const stats = { 
      totalRequests: data.length,
      totalCount: data.reduce((sum, item) => sum + item.count, 0),
      movieRequests: data.filter(item => item.type === 'movie').length,
      seriesRequests: data.filter(item => item.type === 'tv' || item.type === 'series').length
    };

    res.json({
      success: true,
      data: data.sort((a, b) => b.count - a.count),
      stats
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch dashboard data' 
    });
  }
});

// NEW: Delete single request endpoint
app.delete('/api/requests/:tmdbId', (req, res) => {
    try {
        const { tmdbId } = req.params;
        let data = readData();
        const initialLength = data.length;
        data = data.filter(item => item.tmdbId.toString() !== tmdbId.toString());

        if (data.length < initialLength) {
            writeData(data);
            log(`Request deleted: TMDB ID ${tmdbId}`);
            res.json({ success: true, message: 'Request deleted successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Request not found' });
        }
    } catch (error) {
        log(`Delete request error: ${error.message}`, 'ERROR');
        res.status(500).json({ success: false, error: 'Failed to delete request' });
    }
});

// Clear requests endpoint
app.delete('/api/requests/clear', (req, res) => {
  try {
    writeData([]);
    log('All requests cleared');
    res.json({ success: true, message: 'All requests cleared' });
  } catch (error) {
    log(`Clear requests error: ${error.message}`, 'ERROR');
    res.status(500).json({ success: false, error: 'Failed to clear requests' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '2.2.0-professional'
  });
});

// Server status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    server: 'StreamP2P Manager Professional',
    version: '2.2.0-professional',
    uptime: process.uptime(),
    features: [
      '🔍 Advanced Video Search with Episode Organization',
      '📤 Enhanced URL/Torrent Upload with Status Tracking',
      '📝 Optimized Batch Upload Support',
      '🔄 Duplicate Detection & Management',
      '🏷️ Auto Video Renaming with TMDB & IMDB Integration',
      '📊 Comprehensive Analytics Dashboard',
      '🎬 Enhanced Title Parsing (Multiple Formats)',
      '🆔 IMDB ID Integration for Movies & TV Shows',
      '🔁 Single & Batch Video Cloning',
      '🗑️ Single Request Deletion from Dashboard',
      '🛠️ Manual Rename for Failed Items',
      '🧠 vastly improved filename parsing logic'
    ],
    endpoints: {
      'GET /': 'Server status',
      'GET /health': 'Health check',
      'GET /dashboard': 'Management dashboard',
      'GET /api/stream/search': 'Search all videos (with organize option)',
      'GET /api/stream/match': 'Find stream by slug (FIXED)',
      'POST /api/request': 'Submit content request',
      'POST /api/upload/url': 'Upload from URL/torrent',
      'POST /api/upload/batch': 'Batch upload from URLs',
      'GET /api/upload/tus': 'Get TUS upload endpoint',
      'GET /api/upload/status/:taskId': 'Check upload status',
      'GET /api/upload/progress': 'Upload progress with task statuses',
      'GET /api/duplicates/scan': 'Scan for duplicate videos',
      'GET /api/duplicates/progress': 'Duplicate scan progress',
      'DELETE /api/duplicates/delete/:videoId': 'Delete specific video',
      'POST /api/duplicates/batch-delete': 'Batch delete videos',
      'POST /api/rename/batch': 'Start enhanced batch rename (TMDB + IMDB)',
      'POST /api/rename/manual': 'Manually rename a single video (NEW)',
      'GET /api/rename/progress': 'Rename progress',
      'POST /api/video/clone': 'Clone a single video',
      'POST /api/video/clone/batch': 'Clone multiple videos',
      'GET /api/dashboard/data': 'Dashboard data',
      'DELETE /api/requests/clear': 'Clear all requests',
      'DELETE /api/requests/:tmdbId': 'Delete a single request (NEW)'
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: '🎬 StreamP2P Manager Server v2.2 Professional',
    version: '2.2.0-professional',
    status: 'Running',
    newFeatures: [
      '🧠 Rewritten filename parsing logic to handle complex and messy titles.',
      '🎯 More accurate title, year, and episode extraction.',
      '🗑️ Added single request deletion from the dashboard',
      '🛠️ Added manual rename interface for failed batch renames'
    ]
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  log(`Unhandled error: ${error.message}`, 'ERROR');
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('StreamP2P Manager shutting down gracefully...');
  if (progressInterval) clearInterval(progressInterval);
  if (uploadInterval) clearInterval(uploadInterval);
  if (duplicateInterval) clearInterval(duplicateInterval);
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'ERROR');
});

process.on('uncaughtException', (error) => {
  log(`Uncaught Exception: ${error.message}`, 'ERROR');
  process.exit(1);
});

// Start server
app.listen(PORT, () => {
  log(`🚀 StreamP2P Manager v2.2 Professional running on http://localhost:${PORT}`);
  log(`📊 Dashboard: http://localhost:${PORT}/dashboard?pass=${CONFIG.DASHBOARD_PASSWORD}`);
  log(`🔧 API Status: http://localhost:${PORT}/api/status`);
  log(`✨ NEW Features & Fixes:`);
  log(`   🧠 FIXED: Rewritten filename parsing logic for much higher accuracy.`);
  log(`   🎯 FIXED: Highly accurate, strict stream matching endpoint for series.`);
  log(`   🗑️ NEW: Delete single requests directly from the dashboard`);
  log(`   🛠️ NEW: Manually correct and rename files that failed the batch process`);
  log(`🎉 Your professional media management server is ready!`);
});
