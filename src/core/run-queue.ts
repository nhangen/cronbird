interface Entry { name: string; priority: number; seq: number }

export class RunQueue {
  private entries: Entry[] = [];
  private names = new Set<string>();
  private seq = 0;

  enqueue(name: string, priority: number): boolean {
    if (this.names.has(name)) return false;
    this.names.add(name);
    this.entries.push({ name, priority, seq: this.seq++ });
    return true;
  }

  private ordered(): Entry[] {
    // lowest priority number first; FIFO (insertion seq) among equal priority.
    return [...this.entries].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }

  dequeue(): string | null {
    const next = this.ordered()[0];
    if (!next) return null;
    this.entries.splice(this.entries.indexOf(next), 1);
    this.names.delete(next.name);
    return next.name;
  }

  remove(name: string): boolean {
    if (!this.names.has(name)) return false;
    this.entries.splice(this.entries.findIndex((e) => e.name === name), 1);
    this.names.delete(name);
    return true;
  }

  has(name: string): boolean { return this.names.has(name); }
  size(): number { return this.entries.length; }
  snapshot(): { name: string; priority: number }[] {
    return this.ordered().map(({ name, priority }) => ({ name, priority }));
  }
}
