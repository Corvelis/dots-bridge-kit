import CoreAudio
import Foundation

enum AudioDeviceError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case .message(let value): return value
        }
    }
}

func propertyString(_ device: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
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

func allDevices() throws -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else {
        throw AudioDeviceError.message("Could not read CoreAudio device list size")
    }
    var devices = [AudioDeviceID](
        repeating: 0,
        count: Int(size) / MemoryLayout<AudioDeviceID>.size
    )
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &size,
        &devices
    ) == noErr else {
        throw AudioDeviceError.message("Could not read CoreAudio device list")
    }
    return devices
}

func defaultInputDevice() throws -> AudioDeviceID {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &size,
        &device
    ) == noErr else {
        throw AudioDeviceError.message("Could not read default input device")
    }
    return device
}

func setDefaultInputDevice(_ device: AudioDeviceID) throws {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value = device
    let size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        size,
        &value
    ) == noErr else {
        throw AudioDeviceError.message("Could not set default input device")
    }
}

func identifier(_ device: AudioDeviceID) -> String {
    propertyString(device, kAudioDevicePropertyDeviceUID) ?? String(device)
}

func name(_ device: AudioDeviceID) -> String {
    propertyString(device, kAudioObjectPropertyName) ?? "Unknown device"
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else {
        throw AudioDeviceError.message("Usage: audio-device current-input | set-input <name-or-uid> | list")
    }
    switch command {
    case "current-input":
        let device = try defaultInputDevice()
        print(identifier(device))
    case "set-input":
        guard arguments.count >= 2 else { throw AudioDeviceError.message("set-input requires a device name or UID") }
        let requested = arguments[1]
        guard let device = try allDevices().first(where: { name($0) == requested || identifier($0) == requested }) else {
            throw AudioDeviceError.message("CoreAudio device not found: \(requested)")
        }
        try setDefaultInputDevice(device)
        print(identifier(device))
    case "list":
        for device in try allDevices() {
            print("\(identifier(device))\t\(name(device))")
        }
    default:
        throw AudioDeviceError.message("Unknown command: \(command)")
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
