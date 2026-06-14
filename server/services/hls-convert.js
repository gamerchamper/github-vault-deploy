const { execFile, exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const db = require('../db/database');
const accounts = require('./accounts');
const github = require('./github');
const cache = require('./cache');
const storage = require('./storage');
const crypto = require('./crypto');
const { recordBytes } = require('./bandwidth');
const capacity = require('./capacity');
const { REPO_CAPACITY_BYTES } = capacity;

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const CONVERT_DIR = path.join(__dirname, '../../data/hls-convert');
const SEGMENT_DURATION = 6;
const activeJobs = new Map();

function hlsLog(msg) {
  console.log(`[HLS] ${msg}`);
}

function jobKey(userId, fileId) {
  return `${userId}:${fileId}`;
}

function getJob(userId, fileId) {
  return activeJobs.get(jobKey(userId, fileId));
}

function ensureJob(userId, fileId) {
  const key = jobKey(userId, fileId);
  let job = activeJobs.get(key);
  if (!job) {
    job = { cancelled: false, ffmpegChild: null };
    activeJobs.set(key, job);
  }
  return job;
}

function assertNotCancelled(job) {
  if (job?.cancelled) throw new Error('Cancelled');
}

async function cancelConversion(userId, fileId) {
  const job = getJob(userId, fileId);
  if (job) {
    job.cancelled = true;
    if (job.ffmpegChild && !job.ffmpegChild.killed) {
      job.ffmpegChild.kill('SIGTERM');
    }
  }
  capacity.releaseHlsReserve(userId, fileId);
  db.prepare('DELETE FROM hls_segments WHERE file_id = ?').run(fileId);
  db.prepare(`
    UPDATE files SET has_hls = 0, hls_playlist_repo_id = NULL, hls_playlist_path = NULL
    WHERE id = ? AND user_id = ?
  `).run(fileId, userId);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function resolveFfmpeg() {
  const candidates = ['ffmpeg', 'ffmpeg.exe'];
  for (const cmd of candidates) {
    try {
      await execFileAsync(cmd, ['-version'], { timeout: 5000 });
      return cmd;
    } catch {}
  }
  try {
    await execAsync('ffmpeg -version', { timeout: 5000, shell: true });
    return 'ffmpeg';
  } catch {
    return null;
  }
}

let _ffmpegCmd = null;

async function isFfmpegAvailable() {
  if (_ffmpegCmd) return true;
  _ffmpegCmd = await resolveFfmpeg();
  return !!_ffmpegCmd;
}

function ffmpeg() { return _ffmpegCmd || 'ffmpeg'; }

function getFileKey(userId, file) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');
  const masterKey = crypto.getMasterKey(user);
  const encryptionMeta = JSON.parse(file.encryption_meta);
  return crypto.deserializeEncryption(encryptionMeta, masterKey);
}

async function assembleFile(userId, fileId, file, workDir, onProgress) {
  const outPath = path.join(workDir, 'source.mp4');
  const cached = cache.get(userId, fileId);
  if (cached?.path && fs.existsSync(cached.path)) {
    fs.copyFileSync(cached.path, outPath);
    return outPath;
  }

  await storage.downloadFileToPath(userId, fileId, outPath, (fetched, total, phase) => {
    if (!onProgress) return;
    if (phase === 'cached') {
      onProgress({ phase: 'assembling', percent: 5, lastLog: 'Using cached file for HLS conversion...' });
      return;
    }
    const pct = 5 + Math.round((fetched / Math.max(total, 1)) * 20);
    onProgress({
      phase: 'assembling',
      percent: Math.min(25, pct),
      lastLog: `Assembling file (${fetched}/${total} chunks)...`,
    });
  });
  return outPath;
}

function posix(p) { return p.split(path.sep).join('/'); }

async function convertToHls(inputPath, outputDir, segmentDuration, job = null) {
  const playlistPath = path.join(outputDir, 'playlist.m3u8');
  const segPattern = posix(path.join(outputDir, 'segment_%05d.ts'));
  const args = [
    '-y',
    '-i', posix(inputPath),
    '-c', 'copy',
    '-force_key_frames', `expr:gte(t,n_forced*${segmentDuration})`,
    '-f', 'hls',
    '-hls_time', String(segmentDuration),
    '-hls_segment_type', 'mpegts',
    '-hls_list_size', '0',
    '-hls_segment_filename', segPattern,
    '-progress', 'pipe:1',
    '-loglevel', 'warning',
    posix(playlistPath),
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg(), args, { windowsHide: true });
    if (job) job.ffmpegChild = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (job?.cancelled || signal === 'SIGTERM') {
        reject(new Error('Cancelled'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  const segments = fs.readdirSync(outputDir)
    .filter((f) => f.startsWith('segment_') && f.endsWith('.ts'))
    .sort();

  const durations = [];
  let totalDur = 0;
  for (const seg of segments) {
    const segPath = path.join(outputDir, seg);
    const stat = fs.statSync(segPath);
    totalDur += segmentDuration;
    durations.push({ index: segments.indexOf(seg), path: segPath, size: stat.size, duration: segmentDuration });
  }

  return { segments: durations, playlistPath, totalDuration: totalDur };
}

async function uploadSegment(userId, fileId, segment, repos, segmentIndex, pool = null) {
  const repo = storage.pickRepo(repos, segmentIndex);
  const repoPath = `.vault/hls/${fileId}/${String(segmentIndex).padStart(5, '0')}.dat`;
  const data = await fsp.readFile(segment.path);

  const [owner, repoName] = repo.full_name.split('/');
  const octokit = accounts.createClientForRepo(userId, repo);
  const sha = await github.uploadChunk(octokit, owner, repoName, repoPath, data, repo.default_branch);

  db.prepare(`
    INSERT INTO hls_segments (file_id, segment_index, duration, repo_id, repo_path, sha, size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(fileId, segmentIndex, segment.duration, repo.id, repoPath, sha, data.length);

  db.prepare(
    'UPDATE storage_repos SET total_bytes = total_bytes + ?, chunk_count = chunk_count + 1 WHERE id = ?'
  ).run(data.length, repo.id);
  capacity.consumeHlsReserve(userId, fileId, repo.id, data.length);

  recordBytes(userId, fileId, data.length, 'hls_upload');
  if (pool) pool.recordBytes(data.length);

  return { repo: repo.full_name, sha };
}

async function uploadSegmentsParallel(userId, fileId, segments, repos, job, onProgress, taskId) {
  const total = segments.length;
  const pending = segments
    .map((seg, index) => ({ seg, index }))
    .filter(({ seg }) => seg.path !== null);

  let segmentsDone = total - pending.length;
  if (segmentsDone > 0 && onProgress) {
    onProgress({
      phase: 'uploading',
      percent: 50 + Math.round((segmentsDone / total) * 40),
      segmentsDone,
      segmentsTotal: total,
      lastLog: `Resuming: ${segmentsDone}/${total} segments already uploaded`,
    });
  }

  if (!pending.length) return;

  const { createAdaptivePool, mapAdaptive } = require('./adaptive-concurrency');
  const rateLimit = require('./github-rate-limit');

  const tokenKeys = [];
  const seenTokens = new Set();
  for (const repo of repos) {
    try {
      const token = accounts.getTokenForRepo(userId, repo);
      const key = rateLimit.keyForToken(token);
      if (seenTokens.has(key)) continue;
      seenTokens.add(key);
      tokenKeys.push(key);
    } catch {}
  }

  let clearRateCb = () => {};
  for (const tokenKey of tokenKeys) {
    if (!taskId) break;
    const tasks = require('./tasks');
    const clear = rateLimit.setWaitCallback(tokenKey, (info) => {
      const secs = Math.ceil(info.waitMs / 1000);
      const mins = Math.ceil(secs / 60);
      const waitLabel = mins >= 2 ? `${mins} min` : `${secs}s`;
      tasks.update(taskId, userId, {
        phase: 'rate-limit',
        currentRepo: `GitHub rate limit — resuming in ${waitLabel}`,
        lastLog: `Waiting for GitHub rate limit (${waitLabel})`,
      });
    });
    const prev = clearRateCb;
    clearRateCb = () => {
      prev();
      clear();
    };
  }

  const perToken = tokenKeys.map((k) => rateLimit.getRecommendedConcurrency(k, 16));
  const recommended = perToken.length ? Math.max(...perToken) : 16;
  const poolMax = Math.min(32, perToken.reduce((sum, n) => sum + n, 0) || 32);
  const pool = createAdaptivePool(pending.length, {
    max: poolMax,
    initial: recommended,
    getMax: tokenKeys.length
      ? () => Math.min(32, tokenKeys.reduce(
        (sum, k) => sum + rateLimit.getRecommendedConcurrency(k, 16),
        0
      ))
      : null,
  });

  try {
    await mapAdaptive(pending, pool, async ({ seg, index }) => {
      assertNotCancelled(job);
      if (isTaskCancelled(taskId, userId)) throw new Error('Cancelled');

      hlsLog(`Uploading segment ${index + 1}/${total} (${(seg.size / 1024 / 1024).toFixed(2)} MB)`);
      await uploadSegment(userId, fileId, seg, repos, index, pool);

      segmentsDone += 1;
      const pct = 50 + Math.round((segmentsDone / total) * 40);
      if (onProgress) {
        onProgress({
          phase: 'uploading',
          percent: pct,
          segmentsDone,
          segmentsTotal: total,
          lastLog: `Uploaded HLS segment ${segmentsDone}/${total}`,
        });
      }
      hlsLog(`Segment ${index + 1}/${total} uploaded`);
    });
  } finally {
    clearRateCb();
  }
}

function buildRawUrl(fullName, branch, repoPath) {
  return `https://raw.githubusercontent.com/${fullName}/${branch}/${repoPath}`;
}

async function uploadPlaylist(userId, fileId, repos) {
  const repo = storage.pickRepo(repos, 0);

  const segs = db.prepare(`
    SELECT s.segment_index, s.duration, s.repo_path,
           r.full_name, r.default_branch
    FROM hls_segments s
    JOIN storage_repos r ON s.repo_id = r.id
    WHERE s.file_id = ?
    ORDER BY s.segment_index
  `).all(fileId);

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  for (const seg of segs) {
    const rawUrl = buildRawUrl(seg.full_name, seg.default_branch, seg.repo_path);
    lines.push(`#EXTINF:${seg.duration || SEGMENT_DURATION}.000,`);
    lines.push(rawUrl);
  }
  lines.push('#EXT-X-ENDLIST');

  const playlistContent = lines.join('\n');
  const playlistPath = `.vault/hls/${fileId}/playlist.m3u8`;

  const [owner, repoName] = repo.full_name.split('/');
  const octokit = accounts.createClientForRepo(userId, repo);
  const sha = await github.uploadChunk(
    octokit, owner, repoName, playlistPath,
    Buffer.from(playlistContent, 'utf-8'), repo.default_branch
  );

  try {
    db.prepare('UPDATE files SET has_hls = 1, hls_playlist_repo_id = ?, hls_playlist_path = ? WHERE id = ?')
      .run(repo.id, playlistPath, fileId);
  } catch {
    db.prepare('UPDATE files SET has_hls = 1 WHERE id = ?').run(fileId);
  }

  recordBytes(userId, fileId, playlistContent.length, 'hls_upload');

  return { repo: repo.full_name, repoPath: playlistPath, sha };
}

function isTaskCancelled(taskId, userId) {
  if (!taskId) return false;
  const tasks = require('./tasks');
  const task = tasks.get(taskId, userId);
  return task?.phase === 'cancelled' || (task?.status === 'error' && task?.error === 'Cancelled');
}

async function convertFile(userId, fileId, onProgress, taskId = null) {
  hlsLog(`convertFile called userId=${userId} fileId=${fileId}`);
  const job = ensureJob(userId, fileId);
  job.cancelled = false;
  job.ffmpegChild = null;

  const available = await isFfmpegAvailable();
  if (!available) {
    hlsLog('FFmpeg not available');
    throw new Error('FFmpeg is required for HLS conversion but is not installed on the server');
  }
  hlsLog(`FFmpeg binary: ${ffmpeg()}`);

  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) { hlsLog('File not found'); throw new Error('File not found'); }
  if (!file.encryption_meta) { hlsLog(`No encryption_meta (has_hls=${file.has_hls})`); throw new Error('File has no encryption metadata'); }
  if (file.has_hls) { hlsLog('Already has HLS'); return { fileId, hls: true, alreadyConverted: true }; }
  hlsLog(`File: ${file.name}, size=${file.size}, mime=${file.mime_type}`);

  const chunkSample = db.prepare('SELECT chunk_iv FROM chunks WHERE file_id = ? LIMIT 1').get(fileId);
  if (!chunkSample?.chunk_iv && file.size > 0x7fffffff) {
    throw new Error(
      'HLS conversion cannot load this file into memory (over 2 GB with whole-file encryption). '
      + 'Re-upload the file to use chunked encryption, then convert again.'
    );
  }

  const existingSegments = db.prepare(
    'SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?'
  ).get(fileId);
  const hasPartialSegments = existingSegments?.n > 0;
  if (hasPartialSegments) {
    hlsLog(`Found ${existingSegments.n} existing HLS segments — resuming interrupted conversion`);
  }

  const repos = db.prepare(`
    SELECT r.* FROM storage_repos r
    LEFT JOIN linked_accounts la ON r.linked_account_id = la.id
    WHERE r.user_id = ? AND r.is_active = 1 AND r.is_metadata = 0
      AND (r.repo_role IS NULL OR r.repo_role = 'primary')
      AND (r.linked_account_id IS NULL OR (la.is_active = 1 AND la.role = 'storage'))
      AND (COALESCE(r.total_bytes, 0) + COALESCE(r.reserved_bytes, 0) < ?)
    ORDER BY r.chunk_count ASC
  `).all(userId, REPO_CAPACITY_BYTES);
  if (repos.length === 0) { hlsLog('No repos found'); throw new Error('No storage repositories configured'); }
  hlsLog(`Found ${repos.length} repos for HLS storage`);

  ensureDir(CONVERT_DIR);
  const workDir = path.join(CONVERT_DIR, `${userId}_${fileId}`);
  ensureDir(workDir);

  try {
    assertNotCancelled(job);
    if (isTaskCancelled(taskId, userId)) throw new Error('Cancelled');

    let segments;

    if (hasPartialSegments) {
      // Recovery mode — skip FFmpeg, rebuild segment list from DB
      if (onProgress) onProgress({ phase: 'checking', percent: 10, lastLog: 'Recovering interrupted HLS conversion...' });
      segments = db.prepare(`
        SELECT segment_index, duration, size, repo_path
        FROM hls_segments WHERE file_id = ?
        ORDER BY segment_index
      `).all(fileId).map((s) => ({
        index: s.segment_index, duration: s.duration,
        size: s.size, path: null,
      }));
      hlsLog(`Recovered ${segments.length} already-uploaded segments`);
    } else {
      if (onProgress) onProgress({ phase: 'assembling', percent: 5, lastLog: 'Assembling file from chunks...' });
      hlsLog('Assembling file from chunks...');
      assertNotCancelled(job);
      const inputPath = await assembleFile(userId, fileId, file, workDir, onProgress);
      hlsLog(`Assembled file at ${inputPath}`);

      if (onProgress) onProgress({ phase: 'converting', percent: 30, lastLog: 'Running FFmpeg HLS conversion...' });
      hlsLog('Running FFmpeg HLS conversion...');
      assertNotCancelled(job);

      const result = await convertToHls(inputPath, workDir, SEGMENT_DURATION, job);
      segments = result.segments;
      hlsLog(`FFmpeg produced ${segments.length} segments`);
    }

    const total = segments.length;
    const pendingCount = segments.filter((s) => s.path !== null).length;
    if (onProgress) {
      onProgress({
        phase: 'uploading',
        percent: 50,
        segmentsDone: total - pendingCount,
        segmentsTotal: total,
        lastLog: pendingCount
          ? `Uploading ${pendingCount} HLS segments (up to 32 at a time)...`
          : `All ${total} HLS segments already uploaded`,
      });
    }

    await uploadSegmentsParallel(userId, fileId, segments, repos, job, onProgress, taskId);
    hlsLog(`Uploaded ${total} segments`);

    if (onProgress) onProgress({ phase: 'playlist', percent: 92, lastLog: 'Uploading m3u8 playlist...' });
    hlsLog('Uploading m3u8 playlist...');

    const playlist = await uploadPlaylist(userId, fileId, repos);
    hlsLog(`Playlist uploaded: ${playlist.repoPath}`);

    if (onProgress) onProgress({ phase: 'done', percent: 100, lastLog: 'HLS conversion complete' });

    capacity.releaseHlsReserve(userId, fileId);
    return { fileId, hls: true, segments: total, playlist: playlist.repoPath };
  } catch (err) {
    if (err.message !== 'Cancelled') capacity.releaseHlsReserve(userId, fileId);
    throw err;
  } finally {
    activeJobs.delete(jobKey(userId, fileId));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

function resumeInterruptedConversions() {
  db.prepare(`
    UPDATE files SET has_hls = 0, hls_playlist_repo_id = NULL
    WHERE has_hls = 1 AND id IN (
      SELECT DISTINCT file_id FROM hls_segments
      WHERE file_id NOT IN (
        SELECT id FROM files WHERE has_hls = 1 AND hls_playlist_path IS NOT NULL
      )
    )
  `).run();
  console.log('[HLS] Reset partial HLS flags for interrupted conversions');
}

function getHlsSegments(fileId) {
  return db.prepare(`
    SELECT s.segment_index, s.duration, s.size, s.repo_path,
           r.full_name, r.default_branch, r.is_public
    FROM hls_segments s
    JOIN storage_repos r ON s.repo_id = r.id
    WHERE s.file_id = ?
    ORDER BY s.segment_index
  `).all(fileId);
}

function getHlsSegmentCount(fileId) {
  const row = db.prepare('SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?').get(fileId);
  return row?.n || 0;
}

function formatIndexList(indices, max = 12) {
  if (!indices.length) return '';
  if (indices.length <= max) return indices.join(', ');
  return `${indices.slice(0, max).join(', ')}… (+${indices.length - max} more)`;
}

function parsePlaylistSegments(content) {
  const lines = String(content).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const urls = [];
  let hasEndList = false;
  let extinfCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '#EXT-X-ENDLIST') hasEndList = true;
    if (lines[i].startsWith('#EXTINF:')) {
      extinfCount += 1;
      const next = lines[i + 1];
      if (next && !next.startsWith('#')) urls.push(next);
    }
  }
  return { extinfCount, urls, hasEndList };
}

async function rawUrlExists(url) {
  try {
    let resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    if (resp.ok) return true;
    if (resp.status === 404) return false;
    resp = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(10000),
    });
    return resp.ok || resp.status === 206;
  } catch {
    return false;
  }
}

async function fetchRawText(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`Fetch failed (${resp.status})`);
  return resp.text();
}

function hlsRawUrl(repo, repoPath) {
  return storage.githubRawUrl(repo.full_name, repo.default_branch, repoPath);
}

async function checkHlsBlobViaRaw(repo, repoPath) {
  if (!repo?.is_active) return { present: false };
  const present = await rawUrlExists(hlsRawUrl(repo, repoPath));
  return { present };
}

async function verifyHlsOnGitHub(userId, fileId, onProgress = null) {
  const file = db.prepare(`
    SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0
  `).get(fileId, userId);
  if (!file) throw new Error('File not found');

  const segmentCount = getHlsSegmentCount(fileId);
  if (!file.has_hls && segmentCount === 0) {
    throw new Error('File has no HLS data to verify');
  }

  const dbSegments = db.prepare(`
    SELECT s.*, r.full_name, r.default_branch, r.is_active
    FROM hls_segments s
    JOIN storage_repos r ON s.repo_id = r.id
    WHERE s.file_id = ?
    ORDER BY s.segment_index
  `).all(fileId);

  const { mapConcurrent } = require('./chunk-session');
  let checked = 0;
  const segmentTotal = Math.max(dbSegments.length, 1);

  const segmentResults = dbSegments.length
    ? await mapConcurrent(dbSegments, 32, async (seg) => {
      const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(seg.repo_id);
      const result = await checkHlsBlobViaRaw(repo, seg.repo_path);
      checked += 1;
      if (onProgress) {
        onProgress({
          checked,
          total: segmentTotal,
          percent: Math.min(85, Math.round((checked / segmentTotal) * 85)),
          phase: 'segments',
        });
      }
      return { segmentIndex: seg.segment_index, present: result.present };
    })
    : [];

  const missingOnGitHub = segmentResults
    .filter((r) => !r.present)
    .map((r) => r.segmentIndex)
    .sort((a, b) => a - b);
  const verified = segmentResults.filter((r) => r.present).length;

  const indexSet = new Set(dbSegments.map((s) => s.segment_index));
  const gaps = [];
  if (dbSegments.length > 0) {
    const maxIdx = Math.max(...dbSegments.map((s) => s.segment_index));
    for (let i = 0; i <= maxIdx; i++) {
      if (!indexSet.has(i)) gaps.push(i);
    }
  }

  let playlistPresent = false;
  let playlistHasEndList = false;
  let playlistSegmentCount = null;
  let playlistMismatch = false;
  let playlistOnlyMissing = [];

  if (file.hls_playlist_path && file.hls_playlist_repo_id) {
    const playlistRepo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(file.hls_playlist_repo_id);
    if (playlistRepo) {
      const plCheck = await checkHlsBlobViaRaw(playlistRepo, file.hls_playlist_path);
      playlistPresent = plCheck.present;

      if (playlistPresent) {
        try {
          const content = await fetchRawText(hlsRawUrl(playlistRepo, file.hls_playlist_path));
          const parsed = parsePlaylistSegments(content);
          playlistHasEndList = parsed.hasEndList;
          playlistSegmentCount = parsed.extinfCount;

          if (dbSegments.length > 0 && parsed.extinfCount !== dbSegments.length) {
            playlistMismatch = true;
          }

          if (!dbSegments.length && parsed.urls.length) {
            const urlResults = await mapConcurrent(parsed.urls, 32, async (url, idx) => {
              const present = await rawUrlExists(url);
              return { index: idx, present };
            });
            playlistOnlyMissing = urlResults
              .filter((r) => !r.present)
              .map((r) => r.index);
            if (playlistOnlyMissing.length) {
              playlistMismatch = true;
            }
          } else if (dbSegments.length > 0 && parsed.urls.length) {
            const urlResults = await mapConcurrent(parsed.urls, 32, async (url, idx) => {
              const present = await rawUrlExists(url);
              return { index: idx, present };
            });
            const missingFromPlaylist = urlResults.filter((r) => !r.present).map((r) => r.index);
            if (missingFromPlaylist.length) {
              playlistMismatch = true;
              playlistOnlyMissing = missingFromPlaylist;
            }
          }
        } catch (err) {
          hlsLog(`Playlist parse failed for ${fileId}: ${err.message}`);
        }
      }
    }
    if (onProgress) {
      onProgress({ checked: segmentTotal, total: segmentTotal, percent: 95, phase: 'playlist' });
    }
  }

  const issues = [];
  if (gaps.length) {
    issues.push(`Missing segment index(es) in sequence: ${formatIndexList(gaps)}`);
  }
  if (missingOnGitHub.length) {
    issues.push(`Segment(s) missing on GitHub: ${formatIndexList(missingOnGitHub)}`);
  }
  if (file.hls_playlist_path && !playlistPresent) {
    issues.push('m3u8 playlist missing on GitHub');
  }
  if (playlistPresent && playlistHasEndList === false) {
    issues.push('m3u8 playlist is incomplete (missing #EXT-X-ENDLIST)');
  }
  if (playlistMismatch && dbSegments.length > 0) {
    issues.push(`Playlist lists ${playlistSegmentCount} segments but vault has ${dbSegments.length}`);
  }
  if (playlistOnlyMissing.length) {
    issues.push(`${playlistOnlyMissing.length} segment URL(s) in playlist missing on GitHub`);
  }
  if (!file.has_hls && segmentCount > 0) {
    issues.push('HLS conversion was interrupted (segments exist but file is not marked as HLS-ready)');
  }

  const missing = [...new Set([...gaps, ...missingOnGitHub])].sort((a, b) => a - b);

  if (onProgress) {
    onProgress({ checked: segmentTotal, total: segmentTotal, percent: 100, phase: 'done' });
  }

  return {
    valid: issues.length === 0,
    fileId,
    fileName: file.name,
    hasHls: !!file.has_hls,
    totalSegments: dbSegments.length || playlistSegmentCount || 0,
    verified,
    missing,
    gaps,
    missingOnGitHub,
    playlistPresent,
    playlistHasEndList,
    playlistSegmentCount,
    issues,
  };
}

function hasHls(fileId) {
  const row = db.prepare('SELECT has_hls FROM files WHERE id = ?').get(fileId);
  return !!(row?.has_hls);
}

module.exports = {
  convertFile,
  cancelConversion,
  getJob,
  getHlsSegments,
  getHlsSegmentCount,
  hasHls,
  verifyHlsOnGitHub,
  isFfmpegAvailable,
  resumeInterruptedConversions,
};