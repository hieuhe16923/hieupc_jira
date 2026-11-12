import { describe, expect, it } from 'vitest';
import { normalizeJiraBaseUrl, parseJiraInput } from './url-parser';

describe('normalizeJiraBaseUrl', () => {
  it('Jira Cloud → chỉ giữ origin', () => {
    expect(normalizeJiraBaseUrl('https://bidv-vn.atlassian.net/browse/PS0142025-18524')).toBe(
      'https://bidv-vn.atlassian.net',
    );
    expect(normalizeJiraBaseUrl('https://bidv-vn.atlassian.net/jira/software/c/projects/PS/boards/1')).toBe(
      'https://bidv-vn.atlassian.net',
    );
    expect(normalizeJiraBaseUrl('bidv-vn.atlassian.net/')).toBe('https://bidv-vn.atlassian.net');
  });

  it('Server/DC → giữ context path, cắt phần giao diện', () => {
    expect(normalizeJiraBaseUrl('https://jira.example.com/browse/ABC-1?x=1#y')).toBe(
      'https://jira.example.com',
    );
    expect(normalizeJiraBaseUrl('https://example.com/jira/browse/ABC-1')).toBe('https://example.com/jira');
    expect(normalizeJiraBaseUrl('https://example.com/jira/')).toBe('https://example.com/jira');
    expect(normalizeJiraBaseUrl('https://jira.example.com/secure/RapidBoard.jspa?rapidView=1')).toBe(
      'https://jira.example.com',
    );
  });

  it('URL sai → ném lỗi', () => {
    expect(() => normalizeJiraBaseUrl('')).toThrow();
    expect(() => normalizeJiraBaseUrl('http://')).toThrow();
  });
});

describe('parseJiraInput', () => {
  it('nhận issue key trần (không phân biệt hoa thường)', () => {
    expect(parseJiraInput('abc-123')).toEqual({ kind: 'issue', key: 'ABC-123' });
    expect(parseJiraInput('  PRJ_2-9  ')).toEqual({ kind: 'issue', key: 'PRJ_2-9' });
  });

  it('project key có chữ số (Jira Cloud)', () => {
    expect(parseJiraInput('https://bidv-vn.atlassian.net/browse/PS0142025-18524')).toEqual({
      kind: 'issue',
      key: 'PS0142025-18524',
      host: 'bidv-vn.atlassian.net',
    });
  });

  it('nhận /browse/KEY', () => {
    const r = parseJiraInput('https://jira.example.com/browse/ABC-123');
    expect(r).toEqual({ kind: 'issue', key: 'ABC-123', host: 'jira.example.com' });
  });

  it('nhận /browse/KEY có context path, query và hash', () => {
    const r = parseJiraInput('https://example.com/jira/browse/ABC-7?focusedCommentId=1#comment-1');
    expect(r).toMatchObject({ kind: 'issue', key: 'ABC-7' });
  });

  it('nhận /projects/X/issues/KEY', () => {
    const r = parseJiraInput('https://jira.example.com/projects/ABC/issues/ABC-45?filter=allopenissues');
    expect(r).toMatchObject({ kind: 'issue', key: 'ABC-45' });
  });

  it('ưu tiên selectedIssue trên URL board/backlog', () => {
    const r = parseJiraInput(
      'https://jira.example.com/secure/RapidBoard.jspa?rapidView=12&view=planning&selectedIssue=ABC-99',
    );
    expect(r).toMatchObject({ kind: 'issue', key: 'ABC-99' });
  });

  it('nhận URL có jql', () => {
    const r = parseJiraInput(
      'https://jira.example.com/issues/?jql=project%20%3D%20ABC%20AND%20assignee%20%3D%20currentUser()',
    );
    expect(r).toEqual({
      kind: 'jql',
      jql: 'project = ABC AND assignee = currentUser()',
      host: 'jira.example.com',
    });
  });

  it('nhận URL filter', () => {
    expect(parseJiraInput('https://jira.example.com/issues/?filter=10234')).toMatchObject({
      kind: 'filter',
      filterId: '10234',
    });
  });

  it('URL thiếu protocol', () => {
    expect(parseJiraInput('jira.example.com/browse/XYZ-1')).toMatchObject({ kind: 'issue', key: 'XYZ-1' });
  });

  it('báo lỗi với input rỗng hoặc không hợp lệ', () => {
    expect(parseJiraInput('').kind).toBe('invalid');
    expect(parseJiraInput('hello world').kind).toBe('invalid');
    expect(parseJiraInput('https://jira.example.com/secure/Dashboard.jspa').kind).toBe('invalid');
    expect(parseJiraInput('123-ABC').kind).toBe('invalid');
  });
});
