import { useState } from 'react';
import { TimesheetView } from '../components/TimesheetView';
import { thisMonth, type DateRange } from '../lib/dateRanges';

export function WorklogPage() {
  const [range, setRange] = useState<DateRange>(thisMonth);
  return <TimesheetView range={range} onRangeChange={setRange} />;
}
