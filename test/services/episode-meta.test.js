const { expect } = require('chai');
const episodeMeta = require('../../server/services/episode-meta');

describe('episode-meta', function () {
  it('parses SxxExx patterns', function () {
    const meta = episodeMeta.parseEpisodeMeta('Show Name S01E05.mkv');
    expect(meta.match).to.equal(true);
    expect(meta.season).to.equal(1);
    expect(meta.episode).to.equal(5);
    expect(meta.label).to.equal('S01E05');
  });

  it('parses 1x02 patterns', function () {
    const meta = episodeMeta.parseEpisodeMeta('Anime 2x12 - Title.mp4');
    expect(meta.season).to.equal(2);
    expect(meta.episode).to.equal(12);
  });

  it('parses episode-only patterns', function () {
    const meta = episodeMeta.parseEpisodeMeta('Documentary Ep 7.mp4');
    expect(meta.season).to.equal(1);
    expect(meta.episode).to.equal(7);
    expect(meta.label).to.equal('S01E07');
  });

  it('heuristic for 101-style codes', function () {
    const meta = episodeMeta.parseEpisodeMeta('Series 101 - Pilot.mp4');
    expect(meta.season).to.equal(1);
    expect(meta.episode).to.equal(1);
  });

  it('sorts titles by season then episode', function () {
    const names = [
      'Show S01E03',
      'Show S02E01',
      'Show S01E01',
      'Show S01E02',
    ];
    const sorted = [...names].sort(episodeMeta.compareEpisodeTitles);
    expect(sorted).to.deep.equal([
      'Show S01E01',
      'Show S01E02',
      'Show S01E03',
      'Show S02E01',
    ]);
  });

  it('sortItemsByEpisodeMeta respects display_name', function () {
    const items = [
      { id: 'a', name: 'file-a.mp4', display_name: 'S01E03' },
      { id: 'b', name: 'file-b.mp4', display_name: 'S01E01' },
    ];
    const sorted = episodeMeta.sortItemsByEpisodeMeta(items);
    expect(sorted.map((i) => i.id)).to.deep.equal(['b', 'a']);
  });

  it('sorts season folders before newer seasons when filenames only have episode numbers', function () {
    const items = [
      { id: 's2e1', name: 'E01.mkv', parent_path: '/Show/Season 2' },
      { id: 's2e2', name: 'E02.mkv', parent_path: '/Show/Season 2' },
      { id: 's1e1', name: 'E01.mkv', parent_path: '/Show/Season 1' },
      { id: 's1e2', name: 'E02.mkv', parent_path: '/Show/Season 1' },
    ];
    const sorted = episodeMeta.sortItemsByEpisodeMeta(items);
    expect(sorted.map((i) => i.id)).to.deep.equal(['s1e1', 's1e2', 's2e1', 's2e2']);
  });

  it('orders multi-season SxxExx titles oldest season first', function () {
    const names = ['Show S03E01', 'Show S02E01', 'Show S01E01'];
    const sorted = [...names].sort(episodeMeta.compareEpisodeTitles);
    expect(sorted).to.deep.equal(['Show S01E01', 'Show S02E01', 'Show S03E01']);
  });

  it('treats episode-only titles as season 1', function () {
    const meta = episodeMeta.parseEpisodeMeta('Game Of Thrones EP.1 Reactionnn.mp4');
    expect(meta.season).to.equal(1);
    expect(meta.episode).to.equal(1);
    expect(meta.label).to.equal('S01E01');
  });

  it('sorts GOT-style reaction filenames in watch order', function () {
    const items = [
      { name: 'Game Of Thrones S2 EP.1.mp4' },
      { name: 'Game Of Thrones S3 EP.1 Reactionnn.mp4' },
      { name: 'Game Of Thrones EP.1 Reactionnn.mp4' },
      { name: 'Game Of Thrones EP.2 Reactionn.mp4' },
    ];
    const sorted = episodeMeta.sortItemsByEpisodeMeta(items);
    expect(sorted.map((i) => i.name)).to.deep.equal([
      'Game Of Thrones EP.1 Reactionnn.mp4',
      'Game Of Thrones EP.2 Reactionn.mp4',
      'Game Of Thrones S2 EP.1.mp4',
      'Game Of Thrones S3 EP.1 Reactionnn.mp4',
    ]);
  });

  it('prefers short EP.N over packed EP.1NN duplicates for the same episode', function () {
    const items = [
      { name: 'HxH EP.102 Reactionnn.mp4' },
      { name: 'HxH EP.2 Reactionnn.mp4' },
      { name: 'HxH EP.1 Reactionnn.mp4' },
      { name: 'HxH EP.103 Reactionnn.mp4' },
      { name: 'HxH EP.3 Reactionnn.mp4' },
    ];
    const sorted = episodeMeta.sortItemsByEpisodeMeta(items);
    expect(sorted.map((i) => i.name)).to.deep.equal([
      'HxH EP.1 Reactionnn.mp4',
      'HxH EP.2 Reactionnn.mp4',
      'HxH EP.102 Reactionnn.mp4',
      'HxH EP.3 Reactionnn.mp4',
      'HxH EP.103 Reactionnn.mp4',
    ]);
  });

  it('sorts with custom regex saved on playlist', function () {
    const items = [
      { name: 'HxH EP.10 Reactionnn.mp4' },
      { name: 'HxH EP.2 Reactionnn.mp4' },
      { name: 'HxH EP.1 Reactionnn.mp4' },
    ];
    const sorted = episodeMeta.sortItemsByRegex(items, String.raw`EP\.(\d+)`);
    expect(sorted.map((i) => i.name)).to.deep.equal([
      'HxH EP.1 Reactionnn.mp4',
      'HxH EP.2 Reactionnn.mp4',
      'HxH EP.10 Reactionnn.mp4',
    ]);
  });

  it('reorders interleaved EP.N / EP.1NN duplicate filenames', function () {
    const items = [
      { id: 'a', name: 'HxH EP.1 Reactionnn.mp4' },
      { id: 'b', name: 'HxH EP.102 Reactionnn.mp4' },
      { id: 'c', name: 'HxH EP.2 Reactionnn.mp4' },
      { id: 'd', name: 'HxH EP.103 Reactionnn.mp4' },
      { id: 'e', name: 'HxH EP.3 Reactionnn.mp4' },
    ];
    const before = items.map((i) => i.id);
    const sorted = episodeMeta.sortItemsByRegex(items, String.raw`EP\.(\d+)`);
    const after = sorted.map((i) => i.id);
    const moved = after.filter((id, idx) => id !== before[idx]).length;
    expect(moved).to.be.above(0);
    expect(sorted.map((i) => i.name)).to.deep.equal([
      'HxH EP.1 Reactionnn.mp4',
      'HxH EP.2 Reactionnn.mp4',
      'HxH EP.102 Reactionnn.mp4',
      'HxH EP.3 Reactionnn.mp4',
      'HxH EP.103 Reactionnn.mp4',
    ]);
  });

  it('countMatches reports regex hits', function () {
    const items = [
      { name: 'HxH EP.1 Reactionnn.mp4' },
      { name: 'random clip.mp4' },
    ];
    expect(episodeMeta.countMatches(items, String.raw`EP\.(\d+)`)).to.equal(1);
  });
});
