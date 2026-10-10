import Foundation
@main struct BoundedPcmCheck {
    static func main() {
        var buffer = BoundedPcmBuffer(capacity: 16_000)
        let bytes = Data((0..<40_001).map { UInt8($0 % 256) })
        precondition(buffer.append(bytes) == 24_002)
        precondition(buffer.data == bytes.suffix(15_999))
        // stdin may split a sample between reads: only whole samples are fed.
        precondition(buffer.append(Data([1])) == 0)
        var target = [UInt8](repeating: 0, count: 640)
        let count = target.withUnsafeMutableBytes { buffer.copyAvailable(to: $0.baseAddress!, capacity: 640) }
        precondition(count == 640 && Data(target) == bytes.subdata(in: 24_002..<24_642))
        precondition(buffer.data.count == 15_360)
        var immediate = BoundedPcmBuffer()
        let normal = Data([1, 2, 3])
        precondition(immediate.append(normal) == 0)
        let first = target.withUnsafeMutableBytes { immediate.copyAvailable(to: $0.baseAddress!, capacity: 640) }
        precondition(first == 2 && target[0] == 1 && target[1] == 2 && immediate.data == Data([3]))
        _ = immediate.append(Data([4]))
        let second = target.withUnsafeMutableBytes { immediate.copyAvailable(to: $0.baseAddress!, capacity: 640) }
        precondition(second == 2 && target[0] == 3 && target[1] == 4 && immediate.data.isEmpty)
        // Repeated network bursts always remain bounded and aligned.
        for _ in 0..<1000 { _ = immediate.append(Data(repeating: 7, count: 6400)); precondition(immediate.data.count <= 16_000 && immediate.data.count % 2 == 0) }
        print("bounded PCM: overflow, alignment, immediate drain and 1000 bursts passed")
    }
}
