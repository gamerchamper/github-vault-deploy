const { expect } = require('chai');
const chunkLookup = require('../../server/services/chunk-lookup-cache');

describe('chunk-lookup-cache', () => {
  it('should cache 404 blob keys and avoid duplicate pending lookups', async () => {
    chunkLookup.markBlobMissing('owner/repo@main:path/chunk.bin', { confirmed: true });
    expect(chunkLookup.isBlobMissing('owner/repo@main:path/chunk.bin')).to.equal(true);

    const head = await chunkLookup.headBlob('owner', 'repo', 'path/chunk.bin', 'main');
    expect(head.ok).to.equal(false);
    expect(head.cached).to.equal(true);
  });

  it('should apply exponential backoff for sync failures', () => {
    chunkLookup.clearSyncFailure(99, 99);
    chunkLookup.recordSyncFailure(99, 99, 'Not Found');
    const row = chunkLookup.loadSyncFailure(99, 99);
    expect(row.fail_count).to.equal(1);
    expect(row.next_retry_at).to.be.a('string');
    expect(chunkLookup.shouldRetrySync(99, 99)).to.equal(false);

    for (let i = 0; i < 4; i++) chunkLookup.recordSyncFailure(99, 99, 'Not Found');
    expect(chunkLookup.shouldRetrySync(99, 99)).to.equal(false);
    expect(chunkLookup.loadSyncFailure(99, 99).confirmed_missing).to.equal(1);

    chunkLookup.clearSyncFailure(99, 99);
    expect(chunkLookup.shouldRetrySync(99, 99)).to.equal(true);
  });

  it('should produce stable sha from etag', () => {
    const sha = chunkLookup.stableSha('o', 'r', 'p', 'main', '"abc123"');
    expect(sha).to.equal('abc123');
  });

  it('should mark sync failures as confirmed missing immediately', () => {
    chunkLookup.clearSyncFailure(101, 101);
    chunkLookup.markSyncConfirmedMissing(101, 101, 'Chunk not found');
    const row = chunkLookup.loadSyncFailure(101, 101);
    expect(row.confirmed_missing).to.equal(1);
    expect(row.next_retry_at).to.equal(null);
    expect(chunkLookup.shouldRetrySync(101, 101)).to.equal(false);
    chunkLookup.clearSyncFailure(101, 101);
  });
});
