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
		// Every change and deletion in a collection is kept (owner, 2026-09-29): a
		// count limit shared by all collections let one saved form of 29 records
		// push a move out of another collection before anyone could undo it. They
		// go when the collection is put back to an earlier version.
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
	}

	/** @return array<int,array> history rows (json) newest first, optionally scoped to one collection */
	public function listForUser(string $userId, ?int $collectionId = null): array {
		return array_map(fn (HistoryEntity $h) => $h->jsonSerialize(), $this->mapper->listForUser($userId, 100000, $collectionId));
	}

	/** The same rows as listForUser(), as entities (their undo data with them). @return HistoryEntity[] */
	public function listEntitiesForUser(string $userId, ?int $collectionId = null): array {
		return $this->mapper->listForUser($userId, 100000, $collectionId);
	}

	public function clearCollection(int $collectionId): void {
		$this->mapper->deleteForCollection($collectionId);
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

	/**
	 * A deleted collection brought back by undo has a new id, and so have its records:
	 * point the changes still waiting to be undone at the new ids.
	 * @param array<int,int> $recMap old record id => new record id
	 */
	public function remapPending(string $userId, int $oldCid, int $newCid, array $recMap): void {
		$rid = static fn ($id) => $recMap[(int)$id] ?? $id;
		$walk = static function ($v) use (&$walk, $oldCid, $newCid) {
			if (!is_array($v)) {
				return $v;
			}
			foreach ($v as $k => $x) {
				if ($k === 'collectionId' && (int)$x === $oldCid) {
					$v[$k] = $newCid;
				} elseif (is_array($x)) {
					$v[$k] = $walk($x);
				}
			}
			return $v;
		};
		foreach ($this->mapper->listForUser($userId, 100000, null) as $e) {
			if ($e->getUndone()) {
				continue;
			}
			$p = $walk($this->decode($e));
			switch ($p['kind'] ?? '') {
				case 'del_collection':
				case 'restore_collection':
					if ((int)($p['id'] ?? 0) === $oldCid) {
						$p['id'] = $newCid;
					}
					break;
				case 'del_record':
				case 'set_data':
					if (isset($p['id'])) {
						$p['id'] = $rid($p['id']);
					}
					break;
				case 'del_many':
					$p['ids'] = array_map($rid, is_array($p['ids'] ?? null) ? $p['ids'] : []);
					break;
				case 'reorder':
					$p['orders'] = array_map(static fn ($o) => is_array($o) && isset($o[0]) ? [$rid($o[0])] + $o : $o, is_array($p['orders'] ?? null) ? $p['orders'] : []);
					break;
				case 'undo_transfer':
					$p['createdIds'] = array_map($rid, is_array($p['createdIds'] ?? null) ? $p['createdIds'] : []);
					break;
			}
			$e->setUndoData($this->encode($p));
			if ((int)$e->getCollectionId() === $oldCid) {
				$e->setCollectionId($newCid);
			}
			$this->mapper->update($e);
		}
	}

	/** The entry as it is stored now (after remapPending() changed it). */
	public function reload(string $userId, HistoryEntity $e): HistoryEntity {
		foreach ($this->mapper->listForUser($userId, 100000, null) as $h) {
			if ((int)$h->getId() === (int)$e->getId()) {
				return $h;
			}
		}
		return $e;
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
