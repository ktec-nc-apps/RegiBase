<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCA\RegiBase\AppInfo\Application;
use OCA\RegiBase\Db\HistoryEntity;
use OCA\RegiBase\Db\HistoryMapper;
use OCP\IConfig;

/**
 * Records an inverse ("undo") payload for every data-mutating operation and
 * serves the change-history / undo API. Retention is bounded per user by the
 * configurable `undo_limit` (default 100). Payloads are stored as JSON, gzipped
 * when large. The actual reversal is performed by RegiBaseService::undo(), which
 * owns the mappers needed to re-apply state.
 */
class HistoryService {
	public const DEFAULT_LIMIT = 100;
	private const MAX_LIMIT = 1000;
	private const GZIP_OVER = 8192; // bytes of JSON above which we gzip+base64

	public function __construct(
		private HistoryMapper $mapper,
		private IConfig $config,
	) {
	}

	public function getLimit(string $userId): int {
		$v = (int)$this->config->getUserValue($userId, Application::APP_ID, 'undo_limit', (string)self::DEFAULT_LIMIT);
		if ($v < 0) {
			$v = 0;
		}
		if ($v > self::MAX_LIMIT) {
			$v = self::MAX_LIMIT;
		}
		return $v;
	}

	public function setLimit(string $userId, int $n): int {
		$n = max(0, min(self::MAX_LIMIT, $n));
		$this->config->setUserValue($userId, Application::APP_ID, 'undo_limit', (string)$n);
		$this->mapper->pruneToLimit($userId, $n);
		return $n;
	}

	/** Append one inverse entry, then prune to the retention limit. */
	public function record(string $userId, string $op, ?int $collectionId, string $summary, array $undo, ?string $grp = null): void {
		$limit = $this->getLimit($userId);
		if ($limit <= 0) {
			return; // history disabled
		}
		$e = new HistoryEntity();
		$e->setUserId($userId);
		$e->setOp($op);
		$e->setCollectionId($collectionId);
		$e->setSummary(mb_substr($summary, 0, 255));
		$e->setGrp($grp);
		$e->setUndoData($this->encode($undo));
		$e->setUndone(false);
		$e->setCreatedAt(gmdate('Y-m-d\TH:i:s\Z'));
		$this->mapper->insert($e);
		$this->mapper->pruneToLimit($userId, $limit);
	}

	/** @return array<int,array> history rows (json) newest first, optionally scoped to one collection */
	public function listForUser(string $userId, ?int $collectionId = null): array {
		$limit = max(self::DEFAULT_LIMIT, $this->getLimit($userId));
		return array_map(fn (HistoryEntity $h) => $h->jsonSerialize(), $this->mapper->listForUser($userId, $limit, $collectionId));
	}

	public function clearForUser(string $userId, ?int $collectionId = null): void {
		$this->mapper->deleteAllForUser($userId, $collectionId);
	}

	public function activeCount(string $userId): int {
		return $this->mapper->countActive($userId);
	}

	/**
	 * The next batch to undo: the newest not-undone entry, and — if it belongs to
	 * a group — every not-undone sibling of that group, newest first (so callers
	 * apply the inverses in reverse chronological order).
	 * @return HistoryEntity[]
	 */
	public function nextUndoBatch(string $userId, ?int $collectionId = null): array {
		$latest = $this->mapper->latestActive($userId, $collectionId);
		if ($latest === null) {
			return [];
		}
		$grp = $latest->getGrp();
		if ($grp !== null && $grp !== '') {
			return $this->mapper->activeGroup($userId, $grp);
		}
		return [$latest];
	}

	public function markUndone(HistoryEntity $e): void {
		$e->setUndone(true);
		$this->mapper->update($e);
	}

	public function decode(HistoryEntity $e): array {
		$raw = (string)$e->getUndoData();
		if ($raw === '') {
			return [];
		}
		if (str_starts_with($raw, 'gz:')) {
			$bin = base64_decode(substr($raw, 3), true);
			$json = $bin !== false ? @gzuncompress($bin) : false;
			$raw = $json !== false ? $json : '';
		}
		$d = json_decode($raw, true);
		return is_array($d) ? $d : [];
	}

	private function encode(array $undo): string {
		$json = json_encode($undo, JSON_UNESCAPED_UNICODE);
		if ($json === false) {
			$json = '{}';
		}
		if (strlen($json) > self::GZIP_OVER) {
			$gz = gzcompress($json, 6);
			if ($gz !== false) {
				return 'gz:' . base64_encode($gz);
			}
		}
		return $json;
	}
}
