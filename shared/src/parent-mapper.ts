export interface ParentSource {
  key: string;
  issueType: { name: string; subtask: boolean };
  isEpic: boolean;
  /** Parent của issue gốc (khi issue gốc là sub-task) */
  parentKey?: string;
  /** Epic chứa issue gốc */
  epicKey?: string;
}

export interface ParentTarget {
  subtask: boolean;
  isEpic?: boolean;
}

export interface ParentMapping {
  /** fields.parent.key (chỉ cho sub-task) */
  parentKey?: string;
  /** Epic cần gán (Epic Link trên Server/DC) */
  epicKey?: string;
  /** Tạo issue link "relates to" tới key này sau khi tạo */
  relatesToKey?: string;
  error?: string;
}

export function isEpicTypeName(name: string): boolean {
  return name.trim().toLowerCase() === 'epic';
}

/**
 * Map quan hệ cha-con giống Jira:
 * - Gốc Story/Task/Bug + tạo Sub-task → parent = gốc
 * - Gốc Sub-task + tạo Sub-task → parent = parent của gốc
 * - Gốc Epic + tạo Story/Task → Epic Link = gốc
 * - Gốc Story/Task + tạo Task (không phải sub-task) → cùng Epic + link "relates to" gốc
 */
export function mapParent(source: ParentSource, target: ParentTarget): ParentMapping {
  if (target.subtask) {
    if (source.isEpic) {
      return { error: 'Không thể tạo Sub-task trực tiếp dưới Epic. Hãy chọn Story/Task làm issue gốc.' };
    }
    if (source.issueType.subtask) {
      if (!source.parentKey) return { error: `Không xác định được parent của sub-task ${source.key}.` };
      return { parentKey: source.parentKey };
    }
    return { parentKey: source.key };
  }

  if (target.isEpic) {
    return { relatesToKey: source.key };
  }

  if (source.isEpic) {
    return { epicKey: source.key };
  }

  return {
    ...(source.epicKey ? { epicKey: source.epicKey } : {}),
    relatesToKey: source.key,
  };
}
