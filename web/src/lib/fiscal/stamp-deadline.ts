import { addDays, isItalianHoliday, isoWeekday } from "./calendar";

export function stampDeadline(
  year: number,
  quarter: 1 | 2 | 3 | 4,
  due: { q1Cents: number; q2Cents: number },
): string {
  let deadline: string;
  switch (quarter) {
    case 1:
      deadline = due.q1Cents > 500000
        ? `${year}-05-31`
        : due.q1Cents + due.q2Cents > 500000 ? `${year}-09-30` : `${year}-11-30`;
      break;
    case 2:
      deadline = due.q1Cents + due.q2Cents > 500000 ? `${year}-09-30` : `${year}-11-30`;
      break;
    case 3:
      deadline = `${year}-11-30`;
      break;
    case 4:
      deadline = addDays(`${year + 1}-03-01`, -1);
      break;
  }
  // Il sabato resta valido; domeniche e festività nazionali slittano.
  while (isoWeekday(deadline) === 7 || isItalianHoliday(deadline)) {
    deadline = addDays(deadline, 1);
  }
  return deadline;
}
