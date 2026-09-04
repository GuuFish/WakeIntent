export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock implements Clock {
  #current: Date;

  constructor(initialTime: string | Date) {
    this.#current = new Date(
      typeof initialTime === "string" ? initialTime : initialTime.getTime(),
    );
    if (Number.isNaN(this.#current.getTime())) {
      throw new TypeError("FakeClock requires a valid initial time");
    }
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  set(time: string | Date): void {
    const next = new Date(typeof time === "string" ? time : time.getTime());
    if (Number.isNaN(next.getTime())) {
      throw new TypeError("FakeClock requires a valid time");
    }
    this.#current = next;
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) {
      throw new TypeError("advance requires a finite millisecond value");
    }
    this.#current = new Date(this.#current.getTime() + milliseconds);
  }
}
