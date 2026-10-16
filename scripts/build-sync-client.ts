import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { deflateRawSync } from "node:zlib"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

type Target = "windows-x64" | "linux-x64"

const releaseAssets = {
  linux: {
    name: "mutagen-linux-x64.tar.gz",
    url: "https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_linux_amd64_v0.18.1.tar.gz",
    sha256: "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
  },
  windows: {
    name: "mutagen-windows-x64.zip",
    url: "https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_windows_amd64_v0.18.1.zip",
    sha256: "76f8223d5e6b607efdd9516473669ae5492e4f142887352d59bc6934d1f07a2d",
  },
  portableGit: {
    name: "PortableGit-2.56.0.2-64-bit.7z.exe",
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe",
    sha256: "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b",
  },
} as const

function parseArguments(args: string[]) {
  const options: Record<string, string> = {}
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (!key?.startsWith("--") || !args[index + 1]) throw new Error("Expected --origin, --output-dir, and --target options")
    options[key.slice(2)] = args[++index]!
  }
  const target = options.target
  if (target !== "windows-x64" && target !== "linux-x64") throw new Error("--target must be windows-x64 or linux-x64")
  let origin: URL
  try { origin = new URL(options.origin ?? "") } catch { throw new Error("--origin must be an absolute HTTP(S) origin") }
  if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== options.origin) {
    throw new Error("--origin must be an exact HTTP(S) origin without credentials, path, query, or fragment")
  }
  if (!options["output-dir"]) throw new Error("--output-dir is required")
  return { origin: origin.origin, outputDirectory: path.resolve(options["output-dir"]), target: target as Target }
}

function crc32(data: Buffer) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zip(files: Array<{ name: string; contents: Buffer; mode: number }>) {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8")
    const packed = deflateRawSync(file.contents, { level: 9 })
    const checksum = crc32(file.contents)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(packed.length, 18)
    header.writeUInt32LE(file.contents.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, packed)
    const index = Buffer.alloc(46)
    index.writeUInt32LE(0x02014b50, 0)
    index.writeUInt16LE(0x0314, 4)
    index.writeUInt16LE(20, 6)
    index.writeUInt16LE(0x0800, 8)
    index.writeUInt16LE(8, 10)
    index.writeUInt32LE(checksum, 16)
    index.writeUInt32LE(packed.length, 20)
    index.writeUInt32LE(file.contents.length, 24)
    index.writeUInt16LE(name.length, 28)
    index.writeUInt32LE(((file.mode & 0xffff) * 0x10000) >>> 0, 38)
    index.writeUInt32LE(offset, 42)
    central.push(index, name)
    offset += header.length + name.length + packed.length
  }
  const centralDirectory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralDirectory, end])
}

async function fetchPinnedAsset(asset: { name: string; url: string; sha256: string }, destination: string) {
  console.log(`Downloading pinned ${asset.name}`)
  const response = await fetch(asset.url, { redirect: "follow", signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`Unable to download pinned dependency ${asset.name}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error(`SHA-256 verification failed for ${asset.name}`)
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 })
  return bytes
}

function help() {
  console.log("Usage: bun run build:sync-client -- --origin <origin> --output-dir <dir> --target <windows-x64|linux-x64>")
}

if (process.argv.includes("--help") || process.argv.includes("-h")) help()
else {
  const options = parseArguments(process.argv.slice(2))
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const staging = await mkdtemp(path.join(os.tmpdir(), "kanna-sync-client-build-"))
  try {
    await mkdir(options.outputDirectory, { recursive: true, mode: 0o755 })
    const executableName = options.target === "windows-x64" ? "kanna-sync.exe" : "kanna-sync"
    const executablePath = path.join(staging, executableName)
    const bunTarget = options.target === "windows-x64" ? "bun-windows-x64" : "bun-linux-x64"
    const entrypoint = path.join(repositoryRoot, "src/sync-client/main.ts")
    const define = `KANNA_SYNC_SERVER_ORIGIN=${JSON.stringify(options.origin)}`
    const compileArgs = [
      "build", "--compile", `--target=${bunTarget}`, `--outfile=${executablePath}`,
      "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
      "--define", define,
      ...(options.target === "windows-x64" ? ["--windows-hide-console", "--windows-title=Kanna Sync", "--windows-description=Kanna remote workspace sync helper"] : []),
      entrypoint,
    ]
    const compiled = spawnSync(process.execPath, compileArgs, { cwd: repositoryRoot, stdio: "inherit", windowsHide: true })
    if (compiled.error || compiled.status !== 0) throw new Error(`Unable to compile ${options.target} sync client`)
    const executableInfo = await stat(executablePath)
    if (!executableInfo.isFile() || executableInfo.size < 5_000_000) throw new Error("Compiled helper is unexpectedly small")
    const archiveName = `kanna-sync-${options.target}.zip`
    const archivePath = path.join(options.outputDirectory, archiveName)
    const connection = Buffer.from(`${JSON.stringify({ serverOrigin: options.origin })}\n`)
    const mutagen = options.target === "windows-x64" ? releaseAssets.windows : releaseAssets.linux
    const mutagenBytes = await fetchPinnedAsset(mutagen, path.join(staging, mutagen.name))
    const packaged = [
      { name: executableName, contents: await readFile(executablePath), mode: options.target === "linux-x64" ? 0o100755 : 0o100644 },
      { name: "connection.json", contents: connection, mode: 0o100644 },
      { name: mutagen.name, contents: mutagenBytes, mode: 0o100644 },
    ]
    if (options.target === "windows-x64") {
      const portableGitPath = path.join(staging, releaseAssets.portableGit.name)
      const portableGitBytes = await fetchPinnedAsset(releaseAssets.portableGit, portableGitPath)
      packaged.push({ name: releaseAssets.portableGit.name, contents: portableGitBytes, mode: 0o100644 })
    }
    const archive = zip(packaged)
    const temporary = `${archivePath}.${process.pid}.tmp`
    await writeFile(temporary, archive, { flag: "wx", mode: 0o644 })
    await rm(archivePath, { force: true })
    await import("node:fs/promises").then(({ rename }) => rename(temporary, archivePath))
    console.log(`Created ${archivePath} (${archive.length} bytes)`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
