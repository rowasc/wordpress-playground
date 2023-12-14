import { FileEntry } from '@php-wasm/universal';
import {
	COMPRESSION_DEFLATE,
	COMPRESSION_NONE,
	CentralDirectoryEndEntry,
	CentralDirectoryEntry,
	ZipFileHeader,
} from './common';
import {
	SIGNATURE_CENTRAL_DIRECTORY_END,
	SIGNATURE_CENTRAL_DIRECTORY,
	SIGNATURE_FILE,
} from './common';
import { collectBytes, iteratorToStream } from './stream-utils';
import { crc32 } from './crc32';

export function zipFiles(
	files: AsyncIterableIterator<FileEntry> | IterableIterator<FileEntry>
): ReadableStream<Uint8Array> {
	return iteratorToStream(files).pipeThrough(encodeZip());
}

function encodeZip() {
	const offsetToFileHeaderMap: Map<number, ZipFileHeader> = new Map();
	let writtenBytes = 0;
	return new TransformStream<FileEntry, Uint8Array>({
		async transform(entry, controller) {
			const entryBytes = await entry.bytes();
			const compressed = (await collectBytes(
				new Blob([entryBytes])
					.stream()
					.pipeThrough(new CompressionStream('deflate-raw'))
			))!;

			const crcHash = crc32(entryBytes);
			const encodedPath = new TextEncoder().encode(entry.path);

			const zipFileEntry: ZipFileHeader = {
				signature: SIGNATURE_FILE,
				version: 2,
				generalPurpose: 0,
				compressionMethod:
					entry.isDirectory || compressed.byteLength === 0
						? COMPRESSION_NONE
						: COMPRESSION_DEFLATE,
				lastModifiedTime: 0,
				lastModifiedDate: 0,
				crc: crcHash,
				compressedSize: compressed.byteLength,
				uncompressedSize: entryBytes.byteLength,
				path: encodedPath,
				extra: new Uint8Array(0),
			};
			offsetToFileHeaderMap.set(writtenBytes, zipFileEntry);

			const headerBytes = encodeZipFileHeader(zipFileEntry);
			controller.enqueue(headerBytes);
			writtenBytes += headerBytes.byteLength;

			controller.enqueue(compressed);
			writtenBytes += compressed.byteLength;
		},
		flush(controller) {
			const centralDirectoryOffset = writtenBytes;
			let centralDirectorySize = 0;
			for (const [
				fileOffset,
				header,
			] of offsetToFileHeaderMap.entries()) {
				const centralDirectoryEntry: Partial<CentralDirectoryEntry> = {
					...header,
					signature: SIGNATURE_CENTRAL_DIRECTORY,
					fileComment: new Uint8Array(0),
					diskNumber: 1,
					internalAttributes: 0,
					externalAttributes: 0,
					firstByteAt: fileOffset,
				};
				const centralDirectoryEntryBytes = encodeCentralDirectoryEntry(
					centralDirectoryEntry as CentralDirectoryEntry,
					fileOffset
				);
				controller.enqueue(centralDirectoryEntryBytes);
				centralDirectorySize += centralDirectoryEntryBytes.byteLength;
			}
			const centralDirectoryEnd: CentralDirectoryEndEntry = {
				signature: SIGNATURE_CENTRAL_DIRECTORY_END,
				numberOfDisks: 1,
				centralDirectoryOffset,
				centralDirectorySize,
				centralDirectoryStartDisk: 1,
				numberCentralDirectoryRecordsOnThisDisk:
					offsetToFileHeaderMap.size,
				numberCentralDirectoryRecords: offsetToFileHeaderMap.size,
				comment: new Uint8Array(0),
			};
			const centralDirectoryEndBytes =
				encodeCentralDirectoryEnd(centralDirectoryEnd);
			controller.enqueue(centralDirectoryEndBytes);
			offsetToFileHeaderMap.clear();
		},
	});
}

function encodeZipFileHeader(entry: ZipFileHeader) {
	const buffer = new ArrayBuffer(
		30 + entry.path.byteLength + entry.extra.byteLength
	);
	const view = new DataView(buffer);
	view.setUint32(0, entry.signature, true);
	view.setUint16(4, entry.version, true);
	view.setUint16(6, entry.generalPurpose, true);
	view.setUint16(8, entry.compressionMethod, true);
	view.setUint16(10, entry.lastModifiedDate, true);
	view.setUint16(12, entry.lastModifiedTime, true);
	view.setUint32(14, entry.crc, true);
	view.setUint32(18, entry.compressedSize, true);
	view.setUint32(22, entry.uncompressedSize, true);
	view.setUint16(26, entry.path.byteLength, true);
	view.setUint16(28, entry.extra.byteLength, true);
	const uint8Header = new Uint8Array(buffer);
	uint8Header.set(entry.path, 30);
	uint8Header.set(entry.extra, 30 + entry.path.byteLength);
	return uint8Header;
}

function encodeCentralDirectoryEntry(
	entry: CentralDirectoryEntry,
	offset: number
) {
	const buffer = new ArrayBuffer(
		46 + entry.path.byteLength + entry.extra.byteLength
	);
	const view = new DataView(buffer);
	view.setUint32(0, entry.signature, true);
	view.setUint16(4, entry.versionCreated, true);
	view.setUint16(6, entry.versionNeeded, true);
	view.setUint16(8, entry.generalPurpose, true);
	view.setUint16(10, entry.compressionMethod, true);
	view.setUint16(12, entry.lastModifiedDate, true);
	view.setUint16(14, entry.lastModifiedTime, true);
	view.setUint32(16, entry.crc, true);
	view.setUint32(20, entry.compressedSize, true);
	view.setUint32(24, entry.uncompressedSize, true);
	view.setUint16(28, entry.path.byteLength, true);
	view.setUint16(30, entry.extra.byteLength, true);
	view.setUint16(32, entry.fileComment.byteLength, true);
	view.setUint16(34, entry.diskNumber, true);
	view.setUint16(36, entry.internalAttributes, true);
	view.setUint32(38, entry.externalAttributes, true);
	view.setUint32(42, offset, true);
	const uint8Header = new Uint8Array(buffer);
	uint8Header.set(entry.path, 46);
	uint8Header.set(entry.extra, 46 + entry.path.byteLength);
	return uint8Header;
}

function encodeCentralDirectoryEnd(entry: CentralDirectoryEndEntry) {
	const buffer = new ArrayBuffer(22 + entry.comment.byteLength);
	const view = new DataView(buffer);
	view.setUint32(0, entry.signature, true);
	view.setUint16(4, entry.numberOfDisks, true);
	view.setUint16(6, entry.centralDirectoryStartDisk, true);
	view.setUint16(8, entry.numberCentralDirectoryRecordsOnThisDisk, true);
	view.setUint16(10, entry.numberCentralDirectoryRecords, true);
	view.setUint32(12, entry.centralDirectorySize, true);
	view.setUint32(16, entry.centralDirectoryOffset, true);
	view.setUint16(20, entry.comment.byteLength, true);
	const uint8Header = new Uint8Array(buffer);
	uint8Header.set(entry.comment, 22);
	return uint8Header;
}