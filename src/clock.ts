type NowFn = () => number;

let nowSource: NowFn = defaultNow;

function defaultNow(): number {
  return Date.now();
}

export function now(): number {
  return nowSource();
}

export function setNowSource(next: NowFn | null): void {
  nowSource = next ?? defaultNow;
}
