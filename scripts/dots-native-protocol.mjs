export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > 1024 * 1024) throw new Error("Native message exceeds 1 MiB");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > 1024 * 1024) throw new Error("Invalid native message length");
      if (this.buffer.length < length + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")));
      this.buffer = this.buffer.subarray(length + 4);
    }
    return messages;
  }
}
