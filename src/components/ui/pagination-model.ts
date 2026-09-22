export function pageBounds(total: number, size: number, page: number) {
  const pageSize = Math.max(1, Math.trunc(size));
  const count = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.max(0, Math.min(count - 1, Math.trunc(page)));
  const start = current * pageSize;
  return { count, current, start, end: Math.min(total, start + pageSize) };
}

export function pageItems(count: number, current: number): (number | "gap")[] {
  const selected = new Set([0, count - 1]);
  for (let i = Math.max(0, current - 1); i <= Math.min(count - 1, current + 1); i++) selected.add(i);
  if (current < 2) for (let i = 0; i < Math.min(count, 4); i++) selected.add(i);
  if (current > count - 3) for (let i = Math.max(0, count - 4); i < count; i++) selected.add(i);
  const result: (number | "gap")[] = [];
  [...selected].sort((a, b) => a - b).forEach((page, index, all) => {
    if (index && page - all[index - 1] === 2) result.push(page - 1);
    else if (index && page - all[index - 1] > 2) result.push("gap");
    result.push(page);
  });
  return result;
}
