const { execFile, exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const accounts = require('./accounts');
const github = require('./github');
const cache = require('./cache');
const storage = require('./storage');
const crypto = require('./crypto');
const { recordBytes } = require('./bandwidth');
const { REPO_CAPACITY_BYTES } = require('./capacity');

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const CONVERT_DIR = path.join(__dirname, '../../data/hls-convert');
const SEGMENT_DURATION = 6;
const activeJobs = new Map();

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
  const cached = cache.get(userId, fileId);
  if (cached?.path && fs.existsSync(cached.path)) {
    return cached.path;
  }

  const outPath = path.join(workDir, 'source.mp4');
  const { buffer } = await storage.downloadFile(userId, fileId);
  fs.writeFileSync(outPath, buffer);
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

async function uploadSegment(userId, fileId, segment, repos, segmentIndex) {
  const repo = storage.pickRepo(repos, segmentIndex);
  const repoPath = `.vault/hls/${fileId}/${String(segmentIndex).padStart(5, '0')}.dat`;
  const data = fs.readFileSync(segment.path);

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

  recordBytes(userId, fileId, data.length, 'hls_upload');

  return { repo: repo.full_name, sha };
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
  const log = (msg) => { console.log(`[HLS] ${msg}`); };
  log(`convertFile called userId=${userId} fileId=${fileId}`);
  const job = ensureJob(userId, fileId);
  job.cancelled = false;
  job.ffmpegChild = null;

  const available = await isFfmpegAvailable();
  if (!available) {
    log('FFmpeg not available');
    throw new Error('FFmpeg is required for HLS conversion but is not installed on the server');
  }
  log(`FFmpeg binary: ${ffmpeg()}`);

  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) { log('File not found'); throw new Error('File not found'); }
  if (!file.encryption_meta) { log(`No encryption_meta (has_hls=${file.has_hls})`); throw new Error('File has no encryption metadata'); }
  if (file.has_hls) { log('Already has HLS'); return { fileId, hls: true, alreadyConverted: true }; }
  log(`File: ${file.name}, size=${file.size}, mime=${file.mime_type}`);

  const existingSegments = db.prepare(
    'SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?'
  ).get(fileId);
  const hasPartialSegments = existingSegments?.n > 0;
  if (hasPartialSegments) {
    log(`Found ${existingSegments.n} existing HLS segments — resuming interrupted conversion`);
  }

  const repos = db.prepare(`
    SELECT r.* FROM storage_repos r
    LEFT JOIN linked_accounts la ON r.linked_account_id = la.id
    WHERE r.user_id = ? AND r.is_active = 1 AND r.is_metadata = 0
      AND (r.repo_role IS NULL OR r.repo_role = 'primary')
      AND (r.linked_account_id IS NULL OR (la.is_active = 1 AND la.role = 'storage'))
      AND (r.total_bytes IS NULL OR r.total_bytes < ?)
    ORDER BY r.chunk_count ASC
  `).all(userId, REPO_CAPACITY_BYTES);
  if (repos.length === 0) { log('No repos found'); throw new Error('No storage repositories configured'); }
  log(`Found ${repos.length} repos for HLS storage`);

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
      log(`Recovered ${segments.length} already-uploaded segments`);
    } else {
      if (onProgress) onProgress({ phase: 'assembling', percent: 5, lastLog: 'Assembling file from chunks...' });
      log('Assembling file from chunks...');
      assertNotCancelled(job);
      const inputPath = await assembleFile(userId, fileId, file, workDir, onProgress);
      log(`Assembled file at ${inputPath}`);

      if (onProgress) onProgress({ phase: 'converting', percent: 30, lastLog: 'Running FFmpeg HLS conversion...' });
      log('Running FFmpeg HLS conversion...');
      assertNotCancelled(job);

      const result = await convertToHls(inputPath, workDir, SEGMENT_DURATION, job);
      segments = result.segments;
      log(`FFmpeg produced ${segments.length} segments`);
    }

    if (onProgress) onProgress({ phase: 'uploading', percent: 50, lastLog: `Uploading ${segments.length} HLS segments...` });

    const total = segments.length;
    for (let i = 0; i < total; i++) {
      assertNotCancelled(job);
      if (isTaskCancelled(taskId, userId)) throw new Error('Cancelled');
      const seg = segments[i];
      // Skip segments already uploaded (recovery)
      if (seg.path === null) {
        if (onProgress) onProgress({ phase: 'uploading', percent: 50 + Math.round(((i + 1) / total) * 40), segmentsDone: i + 1, segmentsTotal: total, lastLog: `Segment ${i + 1}/${total} already uploaded (recovered)` });
        continue;
      }
      log(`Uploading segment ${i + 1}/${total} (${(seg.size / 1024 / 1024).toFixed(2)} MB)`);
      await uploadSegment(userId, fileId, seg, repos, i);
      log(`Segment ${i + 1}/${total} uploaded`);
      const pct = 50 + Math.round(((i + 1) / total) * 40);
      if (onProgress) onProgress({ phase: 'uploading', percent: pct, segmentsDone: i + 1, segmentsTotal: total, lastLog: `Uploaded HLS segment ${i + 1}/${total}` });
    }
    log(`Uploaded ${total} segments`);

    if (onProgress) onProgress({ phase: 'playlist', percent: 92, lastLog: 'Uploading m3u8 playlist...' });
    log('Uploading m3u8 playlist...');

    const playlist = await uploadPlaylist(userId, fileId, repos);
    log(`Playlist uploaded: ${playlist.repoPath}`);

    if (onProgress) onProgress({ phase: 'done', percent: 100, lastLog: 'HLS conversion complete' });

    return { fileId, hls: true, segments: total, playlist: playlist.repoPath };
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
  isFfmpegAvailable,
  resumeInterruptedConversions,
};