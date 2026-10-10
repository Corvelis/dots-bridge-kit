import Foundation

/// Bounded PCM16 input. Overflow drops old whole samples, never the process.
struct BoundedPcmBuffer {
    private(set) var data = Data()
    let capacity: Int
    init(capacity: Int = 16_000) {
        precondition(capacity > 0 && capacity % 2 == 0)
        self.capacity = capacity
    }
    mutating func append(_ bytes: Data) -> Int {
        data.append(bytes)
        let excess = max(0, data.count - capacity)
        let dropped = excess + excess % 2
        if dropped > 0 { data.removeFirst(dropped) }
        return dropped
    }
    mutating func copyAvailable(to target: UnsafeMutableRawPointer, capacity: Int) -> Int {
        let available = min(capacity, data.count)
        let count = available - available % 2
        if count > 0 {
            data.copyBytes(to: target.assumingMemoryBound(to: UInt8.self), count: count)
            data.removeFirst(count)
        }
        return count
    }
}
