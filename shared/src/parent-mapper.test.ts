import { describe, expect, it } from 'vitest';
import { mapParent, type ParentSource } from './parent-mapper';

const story: ParentSource = {
  key: 'ABC-1',
  issueType: { name: 'Story', subtask: false },
  isEpic: false,
  epicKey: 'ABC-100',
};
const subtask: ParentSource = {
  key: 'ABC-2',
  issueType: { name: 'Sub-task BE', subtask: true },
  isEpic: false,
  parentKey: 'ABC-1',
  epicKey: 'ABC-100',
};
const epic: ParentSource = { key: 'ABC-100', issueType: { name: 'Epic', subtask: false }, isEpic: true };

describe('mapParent', () => {
  it('Story + Sub-task → parent = Story', () => {
    expect(mapParent(story, { subtask: true })).toEqual({ parentKey: 'ABC-1' });
  });

  it('Sub-task + Sub-task → parent = parent của gốc', () => {
    expect(mapParent(subtask, { subtask: true })).toEqual({ parentKey: 'ABC-1' });
  });

  it('Sub-task thiếu parent → lỗi', () => {
    expect(mapParent({ ...subtask, parentKey: undefined }, { subtask: true }).error).toBeTruthy();
  });

  it('Epic + Sub-task → lỗi', () => {
    expect(mapParent(epic, { subtask: true }).error).toBeTruthy();
  });

  it('Epic + Story/Task → Epic Link', () => {
    expect(mapParent(epic, { subtask: false })).toEqual({ epicKey: 'ABC-100' });
  });

  it('Story + Task → cùng Epic + relates to', () => {
    expect(mapParent(story, { subtask: false })).toEqual({ epicKey: 'ABC-100', relatesToKey: 'ABC-1' });
  });

  it('Story không có Epic + Task → chỉ relates to', () => {
    expect(mapParent({ ...story, epicKey: undefined }, { subtask: false })).toEqual({
      relatesToKey: 'ABC-1',
    });
  });

  it('Sub-task + Task → cùng Epic của parent + relates to', () => {
    expect(mapParent(subtask, { subtask: false })).toEqual({ epicKey: 'ABC-100', relatesToKey: 'ABC-2' });
  });

  it('tạo Epic → chỉ relates to', () => {
    expect(mapParent(story, { subtask: false, isEpic: true })).toEqual({ relatesToKey: 'ABC-1' });
  });
});
