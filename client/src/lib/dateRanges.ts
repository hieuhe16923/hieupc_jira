import dayjs, { type Dayjs } from 'dayjs';

export type DateRange = [Dayjs, Dayjs];

/** Thứ Hai của tuần hiện tại (không phụ thuộc locale) */
const monday = () =>
  dayjs()
    .startOf('day')
    .subtract((dayjs().day() + 6) % 7, 'day');

export const thisWeek = (): DateRange => [monday(), monday().add(6, 'day')];
export const thisMonth = (): DateRange => [dayjs().startOf('month'), dayjs().endOf('month')];

/** Khoảng chọn nhanh — tính lại mỗi lần gọi (không bị cũ khi mở app qua ngày) */
export function rangePresets(): { label: string; value: DateRange }[] {
  return [
    { label: 'Tuần này', value: thisWeek() },
    { label: 'Tuần trước', value: [monday().subtract(7, 'day'), monday().subtract(1, 'day')] },
    { label: 'Tháng này', value: thisMonth() },
    {
      label: 'Tháng trước',
      value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')],
    },
  ];
}
