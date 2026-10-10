import AVFoundation
import Foundation
import Speech

private let outputLock = NSLock()

private struct SpeechStatus: Codable {
    let authorization: String
    let ok: Bool
}

private struct SpeechEvent: Codable {
    let text: String
    let final: Bool
}

private func printJSON<T: Encodable>(_ value: T, to handle: FileHandle = .standardOutput) {
    guard let data = try? JSONEncoder().encode(value) else { return }
    outputLock.lock()
    handle.write(data)
    handle.write(Data([0x0A]))
    outputLock.unlock()
}

private func fail(
    _ message: String,
    code: Int32 = 1,
    handle: FileHandle = .standardError
) -> Never {
    printJSON(["error": message], to: handle)
    try? handle.close()
    exit(code)
}

private func writableFile(_ path: String) -> FileHandle {
    FileManager.default.createFile(atPath: path, contents: nil)
    guard let handle = FileHandle(forWritingAtPath: path) else {
        fail("Unable to create speech output file")
    }
    return handle
}

@available(macOS 26.0, *)
private func transcribeOnDevice(inputPath: String) async throws -> String {
    guard SpeechTranscriber.isAvailable else {
        throw NSError(
            domain: "DotsSpeech",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "On-device speech recognition is unavailable"]
        )
    }

    let requestedIdentifier = ProcessInfo.processInfo.environment["DOTS_SPEECH_LOCALE"]
        ?? Locale.current.identifier
    let requestedLocale = Locale(identifier: requestedIdentifier)
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
        throw NSError(
            domain: "DotsSpeech",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Speech recognition is unavailable for locale \(requestedIdentifier)"]
        )
    }

    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await installation.downloadAndInstall()
    }

    let pcm = try Data(contentsOf: URL(fileURLWithPath: inputPath))
    let sampleCount = pcm.count / MemoryLayout<Int16>.size
    if sampleCount == 0 { return "" }
    guard let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    ), let buffer = AVAudioPCMBuffer(
        pcmFormat: format,
        frameCapacity: AVAudioFrameCount(sampleCount)
    ), let destination = buffer.int16ChannelData?[0] else {
        throw NSError(
            domain: "DotsSpeech",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "Unable to create the G2 PCM buffer"]
        )
    }
    buffer.frameLength = AVAudioFrameCount(sampleCount)
    pcm.withUnsafeBytes { bytes in
        guard let source = bytes.baseAddress else { return }
        memcpy(destination, source, sampleCount * MemoryLayout<Int16>.size)
    }

    let audioURL = URL(fileURLWithPath: inputPath).deletingPathExtension().appendingPathExtension("caf")
    let outputFile = try AVAudioFile(
        forWriting: audioURL,
        settings: format.settings,
        commonFormat: .pcmFormatInt16,
        interleaved: true
    )
    try outputFile.write(from: buffer)
    let inputFile = try AVAudioFile(forReading: audioURL)

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let resultTask = Task<String, Error> {
        var parts: [String] = []
        for try await result in transcriber.results {
            let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { parts.append(text) }
        }
        return parts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    do {
        if let finalTime = try await analyzer.analyzeSequence(from: inputFile) {
            try await analyzer.finalizeAndFinish(through: finalTime)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        return try await resultTask.value
    } catch {
        resultTask.cancel()
        await analyzer.cancelAndFinishNow()
        throw error
    }
}

@available(macOS 26.0, *)
private func currentSpeechStatus() async -> SpeechStatus {
    guard SpeechTranscriber.isAvailable else {
        return SpeechStatus(authorization: "unsupportedHardware", ok: false)
    }
    let identifier = ProcessInfo.processInfo.environment["DOTS_SPEECH_LOCALE"]
        ?? Locale.current.identifier
    let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier))
    return SpeechStatus(
        authorization: locale == nil ? "unsupportedLocale:\(identifier)" : "onDevice",
        ok: locale != nil
    )
}

private func runStatus(output: FileHandle = .standardOutput, closeOutput: Bool = false) -> Never {
    guard #available(macOS 26.0, *) else {
        printJSON(SpeechStatus(authorization: "requires macOS 26", ok: false), to: output)
        if closeOutput { try? output.close() }
        exit(2)
    }
    Task {
        let status = await currentSpeechStatus()
        printJSON(status, to: output)
        if closeOutput { try? output.close() }
        exit(status.ok ? 0 : 2)
    }
    dispatchMain()
}

private func runTranscription(inputPath: String, output: FileHandle) -> Never {
    guard #available(macOS 26.0, *) else {
        fail("G2 on-device speech recognition requires macOS 26 or later", handle: output)
    }
    Task {
        do {
            let transcript = try await transcribeOnDevice(inputPath: inputPath)
            printJSON(SpeechEvent(text: transcript, final: true), to: output)
            try? output.close()
            exit(0)
        } catch {
            fail(error.localizedDescription, handle: output)
        }
    }
    dispatchMain()
}

let command = CommandLine.arguments.dropFirst().first ?? "status"
switch command {
case "status", "authorize":
    runStatus()
case "authorize-file":
    guard CommandLine.arguments.count >= 3 else { fail("authorize-file requires an output path") }
    let output = writableFile(CommandLine.arguments[2])
    runStatus(output: output, closeOutput: true)
case "transcribe-file":
    guard CommandLine.arguments.count >= 4 else {
        fail("transcribe-file requires input and output paths")
    }
    let inputPath = CommandLine.arguments[2]
    let output = writableFile(CommandLine.arguments[3])
    runTranscription(inputPath: inputPath, output: output)
default:
    fail("Unknown command '\(command)'")
}
