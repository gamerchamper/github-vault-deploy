import { describe, it, expect } from 'vitest';
import { logger } from '../src/services/logger';

describe('logger', () => {
  it('sanitizes secret keys in details objects', () => {
    const messages: string[] = [];
    logger.setHandler((level, category, message, details) => {
      messages.push(JSON.stringify(details));
    });
    logger.setLevel('debug');
    logger.info('test', 'Connecting', { token: 'gv_abcdef1234567890', url: 'https://example.com' });
    expect(messages.some((m) => m.includes('****'))).toBe(true);
    expect(messages.some((m) => m.includes('abcdef1234567890'))).toBe(false);
  });

  it('sanitizes api keys in details', () => {
    const messages: string[] = [];
    logger.setHandler((level, category, message, details) => {
      messages.push(JSON.stringify(details));
    });
    logger.info('test', 'API key set', { apiKey: 'gv_secret12345678', safe: 'visible' });
    const msg = messages[messages.length - 1];
    expect(msg).toContain('****');
    expect(msg).not.toContain('secret12345678');
    expect(msg).toContain('visible');
  });

  it('does not log below configured level', () => {
    const messages: string[] = [];
    logger.setHandler((level, category, message) => {
      messages.push(message);
    });
    logger.setLevel('error');
    logger.debug('test', 'should not appear');
    logger.info('test', 'should not appear');
    logger.warn('test', 'should not appear');
    logger.error('test', 'should appear');
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('should appear');
  });
});
