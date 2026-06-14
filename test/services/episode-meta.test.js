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
    expect(meta.episode).to.equal(7);
    expect(meta.label).to.equal('Ep 7');
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
});
