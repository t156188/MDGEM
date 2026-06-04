// JavaScript 模板

/**
 * 一个简单的事件发射器示例。
 */
class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }

  emit(event, ...args) {
    (this.handlers.get(event) || []).forEach((fn) => fn(...args));
  }
}

async function main() {
  const bus = new EventBus();
  bus.on("ready", (name) => console.log(`Hello, ${name}!`));

  await new Promise((resolve) => setTimeout(resolve, 100));
  bus.emit("ready", "MDGEM");
}

main().catch((err) => console.error(err));

export { EventBus };
