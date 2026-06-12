const jobs = new Map();

function create(jobId, data = {}) {
  const job = {
    status: 'processing',
    phase: 'starting',
    chunksDone: 0,
    chunksTotal: 0,
    percent: 0,
    fileName: data.fileName || '',
    error: null,
    file: null,
    created: Date.now(),
  };
  jobs.set(jobId, job);
  return job;
}

function update(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch);
  return job;
}

function get(jobId) {
  return jobs.get(jobId) || null;
}

function remove(jobId) {
  jobs.delete(jobId);
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.created < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000);

module.exports = { create, update, get, remove };
