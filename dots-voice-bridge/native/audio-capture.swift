// Capture only Chrome audio.
import AudioToolbox
import AVFAudio
import CoreAudio
import CoreMedia
import CoreGraphics
import Foundation
import ScreenCaptureKit

enum CaptureError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case .message(let value): return value
        }
    }
}

final class ChatGptAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let output = FileHandle.standardOutput
    private var reportedFormat = false
    private var reportedUnsupportedFormat = false

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio, sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }
        do {
            if let pcm = try pcm16Data(from: sampleBuffer), !pcm.isEmpty {
                output.write(pcm)
            }
        } catch {
            if !reportedUnsupportedFormat {
                reportedUnsupportedFormat = true
                writeError("audio conversion failed: \(error)")
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        writeError("capture stopped: \(error)")
        exit(1)
    }

    private func pcm16Data(from sampleBuffer: CMSampleBuffer) throws -> Data? {
        guard
            let description = sampleBuffer.formatDescription,
            let basicDescription = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee
        else {
            throw CaptureError.message("missing audio format description")
        }
        guard basicDescription.mFormatID == kAudioFormatLinearPCM else {
            throw CaptureError.message("expected linear PCM, got format \(basicDescription.mFormatID)")
        }

        var retainedBlockBuffer: CMBlockBuffer?
        var requiredSize = 0
        let sizingStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &requiredSize,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &retainedBlockBuffer
        )
        guard sizingStatus == noErr, requiredSize > 0 else {
            throw CaptureError.message("could not size audio buffer list: \(sizingStatus)")
        }

        let rawList = UnsafeMutableRawPointer.allocate(byteCount: requiredSize, alignment: 16)
        defer { rawList.deallocate() }
        let list = rawList.assumingMemoryBound(to: AudioBufferList.self)
        let readStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: list,
            bufferListSize: requiredSize,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &retainedBlockBuffer
        )
        guard readStatus == noErr else {
            throw CaptureError.message("could not read audio buffer list: \(readStatus)")
        }

        let buffers = UnsafeMutableAudioBufferListPointer(list)
        let frames = sampleBuffer.numSamples
        let sourceChannels = max(1, Int(basicDescription.mChannelsPerFrame))
        let outputChannels = 2
        let flags = basicDescription.mFormatFlags
        let isFloat = flags & kAudioFormatFlagIsFloat != 0
        let isSignedInteger = flags & kAudioFormatFlagIsSignedInteger != 0
        let isNonInterleaved = flags & kAudioFormatFlagIsNonInterleaved != 0 || buffers.count > 1
        let bitsPerChannel = Int(basicDescription.mBitsPerChannel)

        if !reportedFormat {
            reportedFormat = true
            let formatKind = isFloat ? "float" : "integer"
            writeError(
                "source \(Int(basicDescription.mSampleRate)) Hz, \(sourceChannels) ch, "
                    + "\(bitsPerChannel)-bit, \(formatKind)"
            )
        }

        guard (isFloat && (bitsPerChannel == 32 || bitsPerChannel == 64))
            || (isSignedInteger && (bitsPerChannel == 16 || bitsPerChannel == 32))
        else {
            throw CaptureError.message("unsupported PCM format flags=\(flags), bits=\(bitsPerChannel)")
        }

        var samples = [Int16](repeating: 0, count: frames * outputChannels)
        samples.withUnsafeMutableBufferPointer { destination in
            for frame in 0..<frames {
                for channel in 0..<outputChannels {
                    let sourceChannel = min(channel, sourceChannels - 1)
                    let bufferIndex = isNonInterleaved ? min(sourceChannel, buffers.count - 1) : 0
                    guard let source = buffers[bufferIndex].mData else { continue }
                    let sampleIndex = isNonInterleaved ? frame : frame * sourceChannels + sourceChannel
                    let value: Int16
                    if isFloat && bitsPerChannel == 32 {
                        let input = source.assumingMemoryBound(to: Float.self)[sampleIndex]
                        value = int16(from: Double(input))
                    } else if isFloat && bitsPerChannel == 64 {
                        let input = source.assumingMemoryBound(to: Double.self)[sampleIndex]
                        value = int16(from: input)
                    } else if bitsPerChannel == 16 {
                        value = source.assumingMemoryBound(to: Int16.self)[sampleIndex]
                    } else {
                        let input = source.assumingMemoryBound(to: Int32.self)[sampleIndex]
                        value = Int16(clamping: input >> 16)
                    }
                    destination[frame * outputChannels + channel] = value
                }
            }
        }
        return samples.withUnsafeBytes { Data($0) }
    }

    private func int16(from value: Double) -> Int16 {
        Int16(clamping: Int((min(1, max(-1, value)) * 32768).rounded()))
    }
}

final class BlackHoleAudioFeeder {
    private let lock = NSLock()
    private var pending = BoundedPcmBuffer()
    private var droppedSinceReport = 0
    private var lastOverflowReport = -Double.infinity
    private var queue: AudioQueueRef?
    // PCM16 mono / 16 kHz: 640 bytes = 20 ms. Keep three buffers (60 ms)
    // instead of four 100 ms buffers so microphone audio reaches Voice sooner.
    private let bufferBytes: UInt32 = 640
    private let bufferCount = 3

    func start() throws {
        let blackHoleUID = try findAudioDeviceUID(named: "BlackHole 2ch")
        var format = AudioStreamBasicDescription(
            mSampleRate: 16_000,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            mBytesPerPacket: 2,
            mFramesPerPacket: 1,
            mBytesPerFrame: 2,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 16,
            mReserved: 0
        )
        var outputQueue: AudioQueueRef?
        let userData = Unmanaged.passUnretained(self).toOpaque()
        try requireAudioStatus(
            AudioQueueNewOutput(
                &format,
                blackHoleOutputCallback,
                userData,
                nil,
                nil,
                0,
                &outputQueue
            ),
            "create BlackHole output queue"
        )
        guard let outputQueue else {
            throw CaptureError.message("BlackHole output queue was not created")
        }
        queue = outputQueue

        let retainedDeviceUID = blackHoleUID as CFString
        var deviceUID = Unmanaged.passUnretained(retainedDeviceUID)
        try requireAudioStatus(
            AudioQueueSetProperty(
                outputQueue,
                kAudioQueueProperty_CurrentDevice,
                &deviceUID,
                UInt32(MemoryLayout<Unmanaged<CFString>>.size)
            ),
            "select BlackHole output queue device"
        )
        for _ in 0..<bufferCount {
            var buffer: AudioQueueBufferRef?
            try requireAudioStatus(
                AudioQueueAllocateBuffer(outputQueue, bufferBytes, &buffer),
                "allocate BlackHole output buffer"
            )
            if let buffer { fillAndEnqueue(buffer) }
        }
        try requireAudioStatus(AudioQueueStart(outputQueue, nil), "start BlackHole output queue")
        writeError("BlackHole input queue: \(bufferCount) buffers x \(bufferBytes) bytes (20 ms each)")

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            while true {
                let data = FileHandle.standardInput.availableData
                if data.isEmpty { exit(0) }
                self.append(data)
            }
        }
    }

    fileprivate func fillAndEnqueue(_ buffer: AudioQueueBufferRef) {
        guard let queue else { return }
        let target = buffer.pointee.mAudioData
        let capacity = min(Int(buffer.pointee.mAudioDataBytesCapacity), Int(bufferBytes))
        memset(target, 0, capacity)
        lock.lock()
        _ = pending.copyAvailable(to: target, capacity: capacity)
        lock.unlock()
        buffer.pointee.mAudioDataByteSize = UInt32(capacity)
        AudioQueueEnqueueBuffer(queue, buffer, 0, nil)
    }

    private func append(_ data: Data) {
        lock.lock()
        droppedSinceReport += pending.append(data)
        let now = ProcessInfo.processInfo.systemUptime
        var report: String?
        if droppedSinceReport > 0 && now - lastOverflowReport >= 1 {
            report = "input-overflow-recovered droppedBytes=\(droppedSinceReport) bufferedBytes=\(pending.data.count)"
            droppedSinceReport = 0; lastOverflowReport = now
        }
        lock.unlock()
        // stderr must not hold the realtime audio feeder's lock.
        if let report { writeError(report) }
    }
}

func blackHoleOutputCallback(
    _ userData: UnsafeMutableRawPointer?,
    _ queue: AudioQueueRef,
    _ buffer: AudioQueueBufferRef
) {
    guard let userData else { return }
    Unmanaged<BlackHoleAudioFeeder>
        .fromOpaque(userData)
        .takeUnretainedValue()
        .fillAndEnqueue(buffer)
}

func requireAudioStatus(_ status: OSStatus, _ operation: String) throws {
    guard status == noErr else {
        throw CaptureError.message("Could not \(operation): OSStatus \(status)")
    }
}

func findAudioDeviceUID(named requestedName: String) throws -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let system = AudioObjectID(kAudioObjectSystemObject)
    var size: UInt32 = 0
    try requireAudioStatus(
        AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size),
        "size CoreAudio device list"
    )
    var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    try requireAudioStatus(
        AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices),
        "read CoreAudio device list"
    )
    for device in devices where audioDeviceString(device, kAudioObjectPropertyName) == requestedName {
        if let uid = audioDeviceString(device, kAudioDevicePropertyDeviceUID) { return uid }
    }
    throw CaptureError.message("CoreAudio device not found: \(requestedName)")
}

func audioDeviceString(_ device: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
    return status == noErr ? value?.takeUnretainedValue() as String? : nil
}

func writeError(_ value: String) {
    FileHandle.standardError.write(Data("[dots-voice-capture] \(value)\n".utf8))
}

func selectedDisplay(for app: SCRunningApplication, in content: SCShareableContent) throws -> SCDisplay {
    guard let firstDisplay = content.displays.first else {
        throw CaptureError.message("no display is available for capture")
    }
    guard
        let appWindow = content.windows.first(where: { $0.owningApplication?.processID == app.processID })
    else { return firstDisplay }
    let midpoint = CGPoint(x: appWindow.frame.midX, y: appWindow.frame.midY)
    return content.displays.first(where: { $0.frame.contains(midpoint) }) ?? firstDisplay
}

@available(macOS 14.2, *)
func chromeAudioProcesses() throws -> [[String: Any]] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    try requireAudioStatus(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size), "size audio process list")
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    try requireAudioStatus(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &objects), "read audio process list")
    func number(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32 {
        var a = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var v: UInt32 = 0, s = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(object, &a, 0, nil, &s, &v) == noErr ? v : 0
    }
    return objects.compactMap { object in
        var a = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var v: Unmanaged<CFString>?, s = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &a, 0, nil, &s, &v) == noErr,
              let bundle = v?.takeRetainedValue() as String?,
              bundle == "com.google.Chrome" || bundle.hasPrefix("com.google.Chrome.helper") else { return nil }
        return ["objectId": object, "pid": number(object, kAudioProcessPropertyPID), "bundleIdentifier": bundle,
                "input": number(object, kAudioProcessPropertyIsRunningInput), "output": number(object, kAudioProcessPropertyIsRunningOutput)]
    }
}

// Chromium outputs sound from helper processes that ScreenCaptureKit's
// window-owning app filter may omit. A private process tap includes only Chrome.
@available(macOS 14.2, *)
final class ChromeProcessAudioCapture {
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var device = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private var sourceFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private let output = FileHandle.standardOutput

    func start() throws {
        let processes = try chromeAudioProcesses()
        let ids = processes.compactMap { $0["objectId"] as? AudioObjectID }
        guard !ids.isEmpty else { throw CaptureError.message("Chrome has no audio process available") }
        let description = CATapDescription(stereoMixdownOfProcesses: ids)
        description.name = "Dots Chrome Audio"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        if #available(macOS 26.0, *) {
            description.bundleIDs = Array(Set(["com.google.Chrome", "com.google.Chrome.helper"]
                + processes.compactMap { $0["bundleIdentifier"] as? String }))
            description.isProcessRestoreEnabled = true
        }
        try requireAudioStatus(AudioHardwareCreateProcessTap(description, &tap), "create Chrome audio process tap")
        do {
            let aggregate: [String: Any] = [
                kAudioAggregateDeviceNameKey: "Dots Chrome Audio",
                kAudioAggregateDeviceUIDKey: UUID().uuidString,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceIsStackedKey: false,
                kAudioAggregateDeviceTapAutoStartKey: true,
                kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey: true]],
            ]
            try requireAudioStatus(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "create private Chrome tap device")
            var format = AudioStreamBasicDescription()
            var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat,
                mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            try requireAudioStatus(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format), "read Chrome tap format")
            guard let source = AVAudioFormat(streamDescription: &format),
                  let destination = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48_000, channels: 2, interleaved: true),
                  let conversion = AVAudioConverter(from: source, to: destination) else { throw CaptureError.message("Chrome tap format cannot be converted") }
            sourceFormat = source; converter = conversion
            try requireAudioStatus(AudioDeviceCreateIOProcIDWithBlock(&ioProc, device,
                DispatchQueue(label: "org.dotsbridgekit.chrome-process-audio")) { [weak self] _, input, _, _, _ in
                    self?.received(input)
                }, "create Chrome tap IO callback")
            try requireAudioStatus(AudioDeviceStart(device, ioProc), "start Chrome process audio tap")
            writeError("Chrome process tap: \(processes.count) processes; 48000 Hz stereo PCM16")
        } catch { stop(); throw error }
    }

    private func received(_ list: UnsafePointer<AudioBufferList>) {
        guard let source = sourceFormat, let converter else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        guard let first = buffers.first else { return }
        let frames = Int(first.mDataByteSize) / max(1, Int(source.streamDescription.pointee.mBytesPerFrame))
        guard frames > 0, let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(frames)) else { return }
        input.frameLength = AVAudioFrameCount(frames)
        let targets = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
        guard buffers.count == targets.count else { writeError("Chrome tap buffer layout changed"); exit(1) }
        for index in buffers.indices {
            guard let from = buffers[index].mData, let to = targets[index].mData else { continue }
            memcpy(to, from, min(Int(buffers[index].mDataByteSize), Int(targets[index].mDataByteSize)))
        }
        let capacity = AVAudioFrameCount(ceil(Double(frames) * 48_000 / source.sampleRate)) + 128
        guard let converted = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return }
        var supplied = false, error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return input
        }
        if let error { writeError("Chrome tap conversion failed: \(error)"); exit(1) }
        if converted.frameLength > 0, let bytes = converted.audioBufferList.pointee.mBuffers.mData {
            output.write(Data(bytes: bytes, count: Int(converted.frameLength) * 4))
        }
    }

    func stop() {
        if let current = ioProc { AudioDeviceStop(device, current); AudioDeviceDestroyIOProcID(device, current); ioProc = nil }
        if device != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(device); device = AudioObjectID(kAudioObjectUnknown) }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap); tap = AudioObjectID(kAudioObjectUnknown) }
    }
}

@main
struct AppAudioCaptureMain {
    static func main() async {
        do {
            if CommandLine.arguments.contains("--permission-status") {
                print("{\"screenAudioAllowed\":\(CGPreflightScreenCaptureAccess())}")
                return
            }
            if CommandLine.arguments.contains("--chrome-audio-processes") {
                guard #available(macOS 14.2, *) else { throw CaptureError.message("Audio process diagnostics require macOS 14.2") }
                let encoded = try JSONSerialization.data(withJSONObject: chromeAudioProcesses(), options: [.sortedKeys])
                FileHandle.standardOutput.write(encoded)
                return
            }
            if #available(macOS 14.2, *), CommandLine.arguments.contains("--process-tap") {
                let capture = ChromeProcessAudioCapture()
                try capture.start()
                defer { capture.stop() }
                let feeder = BlackHoleAudioFeeder()
                try feeder.start()
                writeError("ready: Chrome process audio only with isolated BlackHole feeder")
                while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
            }
            guard #available(macOS 13.0, *) else {
                throw CaptureError.message("macOS 13 or newer is required")
            }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            if CommandLine.arguments.contains("--chrome-targets") {
                let targets = content.applications.filter {
                    $0.bundleIdentifier == "com.google.Chrome" || $0.bundleIdentifier.hasPrefix("com.google.Chrome.helper")
                }.map { app -> [String: Any] in
                    ["pid": app.processID, "bundleIdentifier": app.bundleIdentifier,
                     "name": app.applicationName,
                     "windows": content.windows.filter { $0.owningApplication?.processID == app.processID }.count]
                }
                let encoded = try JSONSerialization.data(withJSONObject: targets, options: [.sortedKeys])
                FileHandle.standardOutput.write(encoded)
                return
            }
            let acceptedBundleIdentifiers = Set(["com.google.Chrome"])
            guard let chatGpt = content.applications.first(where: {
                acceptedBundleIdentifiers.contains($0.bundleIdentifier)
            }) else {
                throw CaptureError.message("Chrome is not running")
            }

            let display = try selectedDisplay(for: chatGpt, in: content)
            let filter = SCContentFilter(
                display: display,
                including: [chatGpt],
                exceptingWindows: []
            )
            let configuration = SCStreamConfiguration()
            configuration.width = 2
            configuration.height = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            configuration.queueDepth = 2
            configuration.capturesAudio = true
            configuration.sampleRate = 48_000
            configuration.channelCount = 2
            configuration.excludesCurrentProcessAudio = true

            let feeder = BlackHoleAudioFeeder()
            try feeder.start()
            let capture = ChatGptAudioCapture()
            let stream = SCStream(filter: filter, configuration: configuration, delegate: capture)
            try stream.addStreamOutput(
                capture,
                type: .audio,
                sampleHandlerQueue: DispatchQueue(label: "org.dotsbridgekit.dots-audio")
            )
            try await stream.startCapture()
            writeError("ready: Chrome audio only with isolated BlackHole feeder")
            while true {
                try await Task.sleep(nanoseconds: 3_600_000_000_000)
            }
        } catch {
            writeError("error: \(error)")
            exit(1)
        }
    }
}
