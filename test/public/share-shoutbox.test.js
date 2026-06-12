const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

function loadClientModule(relPath) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  const code = fs.readFileSync(fullPath, 'utf8');
  const varMatch = code.match(/\b(const|let|var)\s+(\w+)\s*=\s*\{/);
  if (!varMatch) throw new Error('Could not find object literal assignment in ' + relPath);
  const varName = varMatch[2];
  const fn = new Function('require', `"use strict";\n${code};\nreturn ${varName};`);
  return fn(require);
}

describe('share-shoutbox client', function () {
  let ShareShoutbox;
  let origDoc, origSS, origFetch, origSP;

  before(function () {
    origDoc = global.document;
    origSS = global.sessionStorage;
    origFetch = global.fetch;
    origSP = global.SharePresence;
  });

  beforeEach(function () {
    const mockDoc = (id) => ({
      addEventListener: () => {},
      classList: {
        add: () => {},
        remove: () => {},
        contains: () => false,
      },
      innerHTML: '',
      value: '',
      appendChild: () => {},
      focus: () => {},
    });

    const mockElements = {};
    const getElementById = (id) => {
      if (!mockElements[id]) {
        mockElements[id] = mockDoc(id);
      }
      return mockElements[id];
    };
    const querySelector = (sel) => mockDoc(sel);
    const createElement = (tag) => {
      let _text = '';
      return {
        tagName: tag.toUpperCase(),
        className: '',
        get textContent() { return _text; },
        set textContent(v) { _text = String(v || ''); },
        get innerHTML() {
          return _text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        },
        set innerHTML(v) { _text = String(v || ''); },
        appendChild: () => {},
      };
    };

    global.document = {
      getElementById,
      querySelector,
      createElement,
      addEventListener: () => {},
    };
    global.sessionStorage = { getItem: () => null, setItem: () => {} };
    global.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    global.SharePresence = { getViewerId: () => 'test-viewer' };
  });

  afterEach(function () {
    // reload module fresh each test with clean state
  });

  after(function () {
    if (origDoc !== undefined) global.document = origDoc; else delete global.document;
    if (origSS !== undefined) global.sessionStorage = origSS; else delete global.sessionStorage;
    if (origFetch !== undefined) global.fetch = origFetch; else delete global.fetch;
    if (origSP !== undefined) global.SharePresence = origSP; else delete global.SharePresence;
  });

  function freshInstance() {
    delete require.cache[require.resolve('../../public/js/share-shoutbox.js')];
    return loadClientModule('../public/js/share-shoutbox.js');
  }

  describe('escape', function () {
    it('should escape HTML special characters', function () {
      const ss = freshInstance();
      const result = ss.escape('<script>alert("xss")</script>');
      expect(result).to.not.include('<script>');
      expect(result).to.include('&lt;script&gt;');
    });

    it('should return empty string for null/undefined', function () {
      const ss = freshInstance();
      expect(ss.escape(null)).to.equal('');
      expect(ss.escape(undefined)).to.equal('');
    });

    it('should pass through normal text', function () {
      const ss = freshInstance();
      expect(ss.escape('Hello world')).to.equal('Hello world');
    });

    it('should escape & < > "', function () {
      const ss = freshInstance();
      const result = ss.escape('& < > "');
      expect(result).to.include('&amp;');
      expect(result).to.include('&lt;');
      expect(result).to.include('&gt;');
      expect(result).to.include('&quot;');
    });
  });

  describe('formatPosition', function () {
    it('should return empty string for null/negative', function () {
      ShareShoutbox = freshInstance();
      expect(ShareShoutbox.formatPosition(null)).to.equal('');
      expect(ShareShoutbox.formatPosition(-1)).to.equal('');
    });

    it('should format seconds as m:ss', function () {
      ShareShoutbox = freshInstance();
      expect(ShareShoutbox.formatPosition(0)).to.equal('0:00');
      expect(ShareShoutbox.formatPosition(5)).to.equal('0:05');
      expect(ShareShoutbox.formatPosition(65)).to.equal('1:05');
    });

    it('should format with h:mm:ss for durations >= 1 hour', function () {
      ShareShoutbox = freshInstance();
      expect(ShareShoutbox.formatPosition(3600)).to.equal('1:00:00');
      expect(ShareShoutbox.formatPosition(3661)).to.equal('1:01:01');
      expect(ShareShoutbox.formatPosition(7322)).to.equal('2:02:02');
    });

    it('should pad minutes and seconds', function () {
      ShareShoutbox = freshInstance();
      expect(ShareShoutbox.formatPosition(7)).to.equal('0:07');
      expect(ShareShoutbox.formatPosition(67)).to.equal('1:07');
      expect(ShareShoutbox.formatPosition(607)).to.equal('10:07');
    });
  });

  describe('getVideoPosition', function () {
    it('should return null when videoEl is not set', function () {
      ShareShoutbox = freshInstance();
      ShareShoutbox.videoEl = null;
      expect(ShareShoutbox.getVideoPosition()).to.be.null;
    });

    it('should return 0 when currentTime is 0', function () {
      ShareShoutbox = freshInstance();
      ShareShoutbox.videoEl = { currentTime: 0 };
      expect(ShareShoutbox.getVideoPosition()).to.equal(0);
    });

    it('should return currentTime when > 0', function () {
      ShareShoutbox = freshInstance();
      ShareShoutbox.videoEl = { currentTime: 42.5 };
      expect(ShareShoutbox.getVideoPosition()).to.equal(42.5);
    });

    it('should return null for non-finite values', function () {
      ShareShoutbox = freshInstance();
      ShareShoutbox.videoEl = { currentTime: Infinity };
      expect(ShareShoutbox.getVideoPosition()).to.be.null;

      ShareShoutbox.videoEl = { currentTime: NaN };
      expect(ShareShoutbox.getVideoPosition()).to.be.null;
    });
  });

  describe('checkScroll', function () {
    it('should detect when user is at bottom', function () {
      ShareShoutbox = freshInstance();
      ShareShoutbox.messagesEl = { scrollHeight: 1000, scrollTop: 970, clientHeight: 30 };
      ShareShoutbox.checkScroll();
      expect(ShareShoutbox.isAtBottom).to.be.true;
      expect(ShareShoutbox.userScrolledUp).to.be.false;
    });

    it('should detect when user has scrolled up', function () {
      ShareShoutbox = freshInstance();
      ShareShoutbox.messagesEl = { scrollHeight: 1000, scrollTop: 500, clientHeight: 30 };
      ShareShoutbox.checkScroll();
      expect(ShareShoutbox.isAtBottom).to.be.false;
    });

    it('should not crash when messagesEl is null', function () {
      ShareShoutbox = freshInstance();
      ShareShoutbox.messagesEl = null;
      expect(() => ShareShoutbox.checkScroll()).to.not.throw();
    });
  });
});
