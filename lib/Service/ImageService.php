<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IConfig;

/**
 * Stores record images/files in the user's own Files area, under a
 * configurable base folder (default "RegiBase") with one sub-folder per
 * collection ("RegiBase/<collection name>/"). Files are referenced by their
 * Nextcloud fileId, which is stable across rename/move, and kept in plaintext
 * (owner's decision: single-user access, so at-rest encryption adds little).
 */
class ImageService {
	private const DEFAULT_FOLDER = 'RegiBase';
	private const MIME_EXT = [
		'image/png' => 'png',
		'image/jpeg' => 'jpg',
		'image/webp' => 'webp',
		'image/gif' => 'gif',
	];

	public function __construct(
		private IRootFolder $rootFolder,
		private IConfig $config,
	) {
	}

	/** Per-user base folder name (Files-relative), configurable in settings. */
	public function getBaseFolder(string $userId): string {
		$v = trim((string)$this->config->getUserValue($userId, 'regibase', 'files_folder', self::DEFAULT_FOLDER));
		return $v !== '' ? $this->sanitizePath($v) : self::DEFAULT_FOLDER;
	}

	public function setBaseFolder(string $userId, string $folder): string {
		$folder = $this->sanitizePath(trim($folder));
		if ($folder === '') {
			$folder = self::DEFAULT_FOLDER;
		}
		$this->config->setUserValue($userId, 'regibase', 'files_folder', $folder);
		return $folder;
	}

	/** Keep a single-segment-safe name (no slashes / traversal / reserved). */
	private function sanitizeName(string $name): string {
		$name = str_replace(['/', '\\', "\0"], '-', $name);
		$name = trim($name, " \t.");
		if ($name === '' || $name === '.' || $name === '..') {
			return 'コレクション';
		}
		return mb_substr($name, 0, 120);
	}

	/** Allow a multi-segment relative base path (e.g. "書類/RegiBase"). */
	private function sanitizePath(string $path): string {
		$parts = array_filter(array_map([$this, 'sanitizeName'], explode('/', str_replace('\\', '/', $path))), fn ($p) => $p !== '');
		return implode('/', $parts);
	}

	private function ensureFolder(Folder $parent, string $name): Folder {
		$name = $this->sanitizeName($name);
		if ($parent->nodeExists($name)) {
			$node = $parent->get($name);
			if ($node instanceof Folder) {
				return $node;
			}
			// A file with that name exists — fall back to a suffixed folder.
			$name .= '-files';
			if ($parent->nodeExists($name) && $parent->get($name) instanceof Folder) {
				return $parent->get($name);
			}
		}
		return $parent->newFolder($name);
	}

	/**
	 * Save a data URL into "<base>/<collectionName>/" and return the fileId.
	 * @throws \RuntimeException on invalid data / unsupported type
	 */
	public function saveDataUrl(string $userId, string $collectionName, string $dataUrl): int {
		if (!preg_match('/^data:([^;]+);base64,(.+)$/s', $dataUrl, $m)) {
			throw new \RuntimeException('画像データが不正です');
		}
		$mime = strtolower($m[1]);
		if (!isset(self::MIME_EXT[$mime])) {
			throw new \RuntimeException('対応していない画像形式です（PNG/JPEG/WebP/GIF）');
		}
		$ext = self::MIME_EXT[$mime];
		$buf = base64_decode($m[2], true);
		if ($buf === false) {
			throw new \RuntimeException('画像データが不正です');
		}
		if (strlen($buf) > 15 * 1024 * 1024) {
			throw new \RuntimeException('画像が大きすぎます');
		}

		try {
			$userFolder = $this->rootFolder->getUserFolder($userId);
			$base = $userFolder;
			foreach (explode('/', $this->getBaseFolder($userId)) as $seg) {
				$base = $this->ensureFolder($base, $seg);
			}
			$dir = $this->ensureFolder($base, $collectionName !== '' ? $collectionName : '未分類');

			$name = 'image-' . bin2hex(random_bytes(4)) . '.' . $ext;
			while ($dir->nodeExists($name)) {
				$name = 'image-' . bin2hex(random_bytes(4)) . '.' . $ext;
			}
			$file = $dir->newFile($name, $buf);
			return $file->getId();
		} catch (NotPermittedException $e) {
			throw new \RuntimeException('保存先フォルダに書き込めません');
		}
	}

	/**
	 * Resolve a fileId to its content + mime for the given user.
	 * Only the user's own image files are served.
	 * @return array{content: string, mime: string}|null
	 */
	public function resolve(string $userId, string $id): ?array {
		if (!preg_match('/^\d+$/', $id)) {
			return null;
		}
		try {
			$userFolder = $this->rootFolder->getUserFolder($userId);
		} catch (\Throwable $e) {
			return null;
		}
		$nodes = $userFolder->getById((int)$id);
		$node = $nodes[0] ?? null;
		if (!($node instanceof File)) {
			return null;
		}
		$mime = $node->getMimeType();
		if (strpos($mime, 'image/') !== 0) {
			return null; // never stream non-image user files through this endpoint
		}
		return ['content' => $node->getContent(), 'mime' => $mime];
	}

	// ---- document / notes attachments ----
	// Allowed document types for the "file" field (plus Notes = md/txt).
	private const DOC_EXT = [
		'pdf' => 'application/pdf',
		'odt' => 'application/vnd.oasis.opendocument.text',
		'ods' => 'application/vnd.oasis.opendocument.spreadsheet',
		'odp' => 'application/vnd.oasis.opendocument.presentation',
		'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	];
	private const NOTE_EXT = ['md', 'txt', 'markdown'];

	private function extOf(string $name): string {
		$dot = strrpos($name, '.');
		return $dot === false ? '' : strtolower(substr($name, $dot + 1));
	}

	private function safeFilename(string $name): string {
		$name = str_replace(['/', '\\', "\0"], '-', $name);
		$name = trim($name, " \t");
		if ($name === '' || $name === '.' || $name === '..') {
			$name = 'file';
		}
		return mb_substr($name, 0, 160);
	}

	/**
	 * Save an uploaded document (pdf/odt/ods/odp/docx/xlsx) into
	 * "<base>/<collectionName>/" keeping its original filename. Returns fileId + name.
	 * @return array{id: int, name: string}
	 */
	public function saveDocument(string $userId, string $collectionName, string $filename, string $base64): array {
		$name = $this->safeFilename($filename);
		$ext = $this->extOf($name);
		if (!isset(self::DOC_EXT[$ext])) {
			throw new \RuntimeException('対応していないファイル形式です（PDF / Word / Excel / ODF のみ）');
		}
		$buf = base64_decode($base64, true);
		if ($buf === false) {
			throw new \RuntimeException('ファイルデータが不正です');
		}
		if (strlen($buf) > 50 * 1024 * 1024) {
			throw new \RuntimeException('ファイルが大きすぎます（最大50MB）');
		}
		try {
			$dir = $this->rootFolder->getUserFolder($userId);
			foreach (explode('/', $this->getBaseFolder($userId)) as $seg) {
				$dir = $this->ensureFolder($dir, $seg);
			}
			$dir = $this->ensureFolder($dir, $collectionName !== '' ? $collectionName : '未分類');
			$stem = substr($name, 0, strlen($name) - strlen($ext) - 1);
			$fname = $name;
			$n = 2;
			while ($dir->nodeExists($fname)) {
				$fname = $stem . ' (' . $n++ . ').' . $ext;
			}
			$file = $dir->newFile($fname, $buf);
			return ['id' => $file->getId(), 'name' => $fname];
		} catch (NotPermittedException $e) {
			throw new \RuntimeException('保存先フォルダに書き込めません');
		}
	}

	/** File name + raw bytes for a stored attachment (used by backup). */
	public function fileContentById(string $userId, string $id): ?array {
		$node = $this->nodeById($userId, $id);
		if ($node === null) {
			return null;
		}
		try {
			return ['name' => $node->getName(), 'content' => $node->getContent()];
		} catch (\Throwable $e) {
			return null;
		}
	}

	/** Save raw bytes under the base folder's "_restored" subfolder; returns the new fileId (used by restore). */
	public function saveRaw(string $userId, string $name, string $content): int {
		$name = $this->safeFilename($name);
		if ($name === '') {
			$name = 'file';
		}
		try {
			$dir = $this->rootFolder->getUserFolder($userId);
			foreach (explode('/', $this->getBaseFolder($userId)) as $seg) {
				$dir = $this->ensureFolder($dir, $seg);
			}
			$dir = $this->ensureFolder($dir, '_restored');
			$ext = $this->extOf($name);
			$stem = $ext !== '' ? substr($name, 0, strlen($name) - strlen($ext) - 1) : $name;
			$fname = $name;
			$n = 2;
			while ($dir->nodeExists($fname)) {
				$fname = $ext !== '' ? ($stem . ' (' . $n++ . ').' . $ext) : ($name . ' (' . $n++ . ')');
			}
			return $dir->newFile($fname, $content)->getId();
		} catch (NotPermittedException $e) {
			throw new \RuntimeException('保存先フォルダに書き込めません');
		}
	}

	private function nodeById(string $userId, string $id): ?File {
		if (!preg_match('/^\d+$/', $id)) {
			return null;
		}
		try {
			$userFolder = $this->rootFolder->getUserFolder($userId);
		} catch (\Throwable $e) {
			return null;
		}
		$node = $userFolder->getById((int)$id)[0] ?? null;
		return $node instanceof File ? $node : null;
	}

	private function metaFor(File $node): array {
		$name = $node->getName();
		$ext = $this->extOf($name);
		$mime = $node->getMimeType();
		$isImage = strpos($mime, 'image/') === 0;
		$isNote = in_array($ext, self::NOTE_EXT, true);
		$kind = $isImage ? 'image' : ($isNote ? 'note' : ($ext === 'pdf' ? 'pdf' : (isset(self::DOC_EXT[$ext]) ? 'office' : 'other')));
		return [
			'id' => $node->getId(),
			'name' => $name,
			'mime' => $mime,
			'size' => $node->getSize(),
			'ext' => $ext,
			'kind' => $kind,
			'is_note' => $isNote,
			'is_image' => $isImage,
		];
	}

	/**
	 * Metadata for an attached file (document or Notes note).
	 * @return array|null
	 */
	public function fileMeta(string $userId, string $id): ?array {
		$node = $this->nodeById($userId, $id);
		return $node === null ? null : $this->metaFor($node);
	}

	/**
	 * Resolve a Files-relative path (from the Nextcloud file picker) to metadata.
	 * @return array|null
	 */
	public function resolveByPath(string $userId, string $path): ?array {
		try {
			$userFolder = $this->rootFolder->getUserFolder($userId);
			$node = $userFolder->get(ltrim($path, '/'));
		} catch (\Throwable $e) {
			return null;
		}
		return $node instanceof File ? $this->metaFor($node) : null;
	}

	/**
	 * List the contents of a Files folder for the app's own file picker.
	 * Returns folders first, then files, sorted naturally by name.
	 * @return array|null  null when the path is not a readable folder
	 */
	public function browse(string $userId, string $path): ?array {
		try {
			$userFolder = $this->rootFolder->getUserFolder($userId);
			$rel = trim($path, '/');
			$node = $rel === '' ? $userFolder : $userFolder->get($rel);
		} catch (\Throwable $e) {
			return null;
		}
		if (!($node instanceof Folder)) {
			return null;
		}
		$entries = [];
		foreach ($node->getDirectoryListing() as $child) {
			$isDir = $child instanceof Folder;
			$childRel = ltrim((string)($userFolder->getRelativePath($child->getPath()) ?? ''), '/');
			$mime = $isDir ? '' : $child->getMimeType();
			$entries[] = [
				'name' => $child->getName(),
				'path' => $childRel,
				'is_dir' => $isDir,
				'is_image' => !$isDir && strpos($mime, 'image/') === 0,
				'id' => $child->getId(),
				'mime' => $mime,
				'size' => $isDir ? 0 : $child->getSize(),
			];
		}
		usort($entries, static function (array $a, array $b): int {
			if ($a['is_dir'] !== $b['is_dir']) {
				return $a['is_dir'] ? -1 : 1;
			}
			return strnatcasecmp($a['name'], $b['name']);
		});
		$parent = null;
		if ($rel !== '') {
			$p = dirname($rel);
			$parent = ($p === '.' || $p === '/') ? '' : $p;
		}
		return ['path' => $rel, 'parent' => $parent, 'entries' => $entries];
	}

	/**
	 * Move an attachment to the trash — but ONLY if RegiBase created it
	 * (i.e. it lives under the user's RegiBase base folder). Files that were
	 * merely referenced (picked existing files / Notes notes) are left alone.
	 */
	public function trashIfOwned(string $userId, string $id): bool {
		$node = $this->nodeById($userId, $id);
		if ($node === null) {
			return false;
		}
		try {
			$userFolder = $this->rootFolder->getUserFolder($userId);
			$rel = $userFolder->getRelativePath($node->getPath());
		} catch (\Throwable $e) {
			return false;
		}
		if ($rel === null) {
			return false;
		}
		$rel = ltrim($rel, '/');
		$base = $this->getBaseFolder($userId);
		if ($rel !== $base && strpos($rel, $base . '/') !== 0) {
			return false; // outside RegiBase folder -> just a reference, keep it
		}
		try {
			$node->delete(); // goes to Nextcloud trash (trashbin app)
			return true;
		} catch (\Throwable $e) {
			return false;
		}
	}

	/**
	 * Resolve an attached file for download (documents + notes only).
	 * @return array{content:string,mime:string,name:string}|null
	 */
	public function resolveFile(string $userId, string $id): ?array {
		$node = $this->nodeById($userId, $id);
		if ($node === null) {
			return null;
		}
		$ext = $this->extOf($node->getName());
		if (!isset(self::DOC_EXT[$ext]) && !in_array($ext, self::NOTE_EXT, true)) {
			return null;
		}
		return ['content' => $node->getContent(), 'mime' => $node->getMimeType(), 'name' => $node->getName()];
	}
}
