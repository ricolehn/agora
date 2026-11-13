// A ZIP archive written straight into a stream, entry by entry (for downloading several media files at once): the
// files are stored as they are (pictures and videos do not get smaller anyway), so nothing has to be held in memory
// or on disk. Plain ZIP without ZIP64: at most 65535 entries and 4 GB, which the caller checks beforehand.
const zlib = require('zlib');

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
// Bit 3: sizes and checksum follow the data; bit 11: names are UTF-8
const FLAGS = 0x0808;

/** Date and time in the MS-DOS form ZIP uses (local time, two-second steps, 1980 at the earliest). */
function dosDateTime(value) {
  const date = value ? new Date(value) : new Date();
  const valid = Number.isFinite(date.getTime()) && date.getFullYear() >= 1980 ? date : new Date(1980, 0, 1);
  return {
    time: (valid.getHours() << 11) | (valid.getMinutes() << 5) | Math.floor(valid.getSeconds() / 2),
    date: ((valid.getFullYear() - 1980) << 9) | ((valid.getMonth() + 1) << 5) | valid.getDate()
  };
}

class ZipWriter {
  /** [out] is a writable stream (the HTTP answer). */
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
  }

  async write(buffer) {
    this.offset += buffer.length;
    if (this.offset > MAX_BYTES) throw new Error('The archive is larger than 4 GB.');
    if (!this.out.write(buffer)) {
      await new Promise((resolve, reject) => {
        const done = (err) => {
          this.out.off('drain', done);
          this.out.off('close', closed);
          if (err) reject(err);
          else resolve();
        };
        const closed = () => done(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        this.out.on('drain', done);
        this.out.on('close', closed);
      });
    }
  }

  async localHeader(name, modified, { folder = false } = {}) {
    if (this.entries.length >= MAX_ENTRIES) throw new Error('Too many files for one archive.');
    const nameBytes = Buffer.from(folder ? `${name}/` : name, 'utf8');
    const { time, date } = dosDateTime(modified);
    const entry = { nameBytes, time, date, offset: this.offset, crc: 0, size: 0, folder };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(folder ? 0x0800 : FLAGS, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // checksum and sizes: 0 here, in the data descriptor after the data (folders have none)
    header.writeUInt16LE(nameBytes.length, 26);
    await this.write(Buffer.concat([header, nameBytes]));
    this.entries.push(entry);
    return entry;
  }

  /** An (empty) folder of its own, so it is there after unpacking. */
  async addFolder(name, modified) {
    await this.localHeader(name, modified, { folder: true });
  }

  /** A file from [chunks] (an async iterable of Buffers / Uint8Arrays). */
  async addFile(name, modified, chunks) {
    const entry = await this.localHeader(name, modified);
    let crc = 0;
    let size = 0;
    for await (const chunk of chunks) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = zlib.crc32(buffer, crc);
      size += buffer.length;
      await this.write(buffer);
    }
    entry.crc = crc >>> 0;
    entry.size = size;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
  }

  /** The table of contents at the end; the archive is complete after this (the stream is not ended). */
  async finish() {
    const start = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(0x0314, 4); // made by: Unix, ZIP 2.0
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(entry.folder ? 0x0800 : FLAGS, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBytes.length, 28);
      // rwxr-xr-x for folders, rw-r--r-- for files (and the DOS folder flag)
      header.writeUInt32LE(entry.folder ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
      header.writeUInt32LE(entry.offset, 42);
      await this.write(Buffer.concat([header, entry.nameBytes]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
  }
}

module.exports = { ZipWriter, MAX_ENTRIES, MAX_BYTES };
