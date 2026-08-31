<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCA\RegiBase\AppInfo\Application;
use OCA\RegiBase\Db\RecordVersionEntity;
use OCA\RegiBase\Db\RecordVersionMapper;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\IConfig;

/**
 * Keeping the last few versions of a record beside it -- the same idea as
 * EditBase's VersionService, adapted from sibling files to sibling database
 * rows since a RegiBase record has no file of its own. A version is a
 * snapshot of the record's own fields (data + reading); #1 is always the
 * most recent, older ones shift down, and the oldest falls off once past
 * the user's keep-count.
 */
class RecordVersionService {
	public const MAX = 99;
	private const DEFAULT_KEEP = 10;

	public function __construct(
		private RecordVersionMapper $mapper,
		private IConfig $config,
	) {
	}

	/** How many versions of a record this user keeps; nought means the feature is off. */
	public function keep(string $userId): int {
		$n = (int)$this->config->getUserValue($userId, Application::APP_ID, 'version_keep', (string)self::DEFAULT_KEEP);
		return max(0, min(self::MAX, $n));
	}

	public function setKeep(string $userId, int $n): int {
		$n = max(0, min(self::MAX, $n));
		$this->config->setUserValue($userId, Application::APP_ID, 'version_keep', (string)$n);
		return $n;
	}

	/** When a version is taken: every edit, or only the ones the writer asks for. */
	public function when(string $userId): string {
		$when = $this->config->getUserValue($userId, Application::APP_ID, 'version_when', 'manual');
		return $when === 'auto' ? 'auto' : 'manual';
	}

	public function setWhen(string $userId, string $when): string {
		$when = $when === 'auto' ? 'auto' : 'manual';
		$this->config->setUserValue($userId, Application::APP_ID, 'version_when', $when);
		return $when;
	}

	/**
	 * Put the record as it stood before the edit that is about to overwrite it
	 * into #1, shifting what was there down. $snapshot is that prior state
	 * (typically ['data' => ..., 'reading' => ...]).
	 */
	public function take(int $recordId, array $snapshot, int $keep): void {
		if ($keep < 1) {
			return;
		}
		// Anything at or past the limit falls off — not just the single oldest
		// slot, since the keep-count may have just been lowered, leaving more
		// than one version stranded past the new limit.
		$this->mapper->deleteFromNumber($recordId, $keep);
		for ($i = $keep - 1; $i >= 1; $i--) {
			$node = $this->mapper->findByRecordAndNumber($recordId, $i);
			if ($node === null) {
				continue;
			}
			$node->setNumber($i + 1);
			$this->mapper->update($node);
		}
		$e = new RecordVersionEntity();
		$e->setRecordId($recordId);
		$e->setNumber(1);
		$json = json_encode($snapshot, JSON_UNESCAPED_UNICODE);
		$e->setData($json !== false ? $json : '{}');
		$e->setCreatedAt(gmdate('Y-m-d\TH:i:s\Z'));
		$this->mapper->insert($e);
	}

	/** The versions of a record, newest first. */
	public function list(int $recordId): array {
		return array_map(fn (RecordVersionEntity $e) => $e->jsonSerialize(), $this->mapper->listForRecord($recordId));
	}

	/** What one version holds. */
	public function read(int $recordId, int $number): array {
		$e = $this->mapper->findByRecordAndNumber($recordId, $number);
		if ($e === null) {
			throw new DoesNotExistException('there is no version ' . $number);
		}
		$d = json_decode($e->getData() ?: '{}', true);
		return is_array($d) ? $d : [];
	}

	/** The versions go with the record when it goes. */
	public function drop(int $recordId): void {
		$this->mapper->deleteAllForRecord($recordId);
	}
}
