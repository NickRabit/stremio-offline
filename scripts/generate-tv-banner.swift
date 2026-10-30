#!/usr/bin/env swift
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let appXML = try String(contentsOf: root.appendingPathComponent("android-tv/app/src/main/res/values/app.xml"), encoding: .utf8)
let expression = try NSRegularExpression(pattern: #"<string name="app_name"[^>]*>([^<]+)</string>"#)
let match = expression.firstMatch(in: appXML, range: NSRange(appXML.startIndex..., in: appXML))!
let name = String(appXML[Range(match.range(at: 1), in: appXML)!])

for (density, scale) in [("xhdpi", 1.0), ("xxhdpi", 1.5), ("xxxhdpi", 2.0)] {
    let width = Int(320 * scale), height = Int(180 * scale)
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let graphics = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    let context = graphics.cgContext
    context.scaleBy(x: scale, y: scale)
    NSColor(srgbRed: 11 / 255, green: 14 / 255, blue: 19 / 255, alpha: 1).setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: 320, height: 180)).fill()
    let icon = NSBezierPath(roundedRect: NSRect(x: 116, y: 72, width: 88, height: 88), xRadius: 25, yRadius: 25)
    NSGradient(starting: NSColor(srgbRed: 1, green: 91 / 255, blue: 56 / 255, alpha: 1),
        ending: NSColor(srgbRed: 168 / 255, green: 60 / 255, blue: 121 / 255, alpha: 1))!
        .draw(in: icon, angle: -45)
    NSColor.white.setStroke()
    let ring = NSBezierPath(ovalIn: NSRect(x: 131, y: 87, width: 58, height: 58))
    ring.lineWidth = 4
    ring.stroke()
    NSColor.white.setFill()
    let play = NSBezierPath()
    play.move(to: NSPoint(x: 152, y: 103))
    play.line(to: NSPoint(x: 174, y: 116))
    play.line(to: NSPoint(x: 152, y: 129))
    play.close()
    play.fill()
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 22, weight: .semibold),
        .foregroundColor: NSColor.white,
    ]
    let title = name as NSString
    let size = title.size(withAttributes: attributes)
    title.draw(at: NSPoint(x: (320 - size.width) / 2, y: 25), withAttributes: attributes)
    NSGraphicsContext.restoreGraphicsState()
    let directory = root.appendingPathComponent("android-tv/app/src/main/res/drawable-\(density)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("banner.png"))
}
