<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * Secret values kept outside the records themselves: in the numbered versions beside each
 * record, in the versions by session (what a record was before a session first touched it)
 * and in the undo history. A master key change (set, change, remove) has to reach them too,
 * or the history keeps plain text after encryption is switched on, and an undo or a version
 * restore after a key change writes back values nobody can open (review P9, K12). The
 * versions by session were left out, and putting one back brought the old values back
 * (review).
 *
 * The page does the cryptography; this lists what it has to transform and writes the result
 * back. A value is included when its field is secret, or when it is encrypted whatever the
 * field is now (a field whose secret mark was taken off still holds ciphertext).
 */
class SecretSweep {
	private const ENC = 'rbenc1:';
	/** A version-by-session item is listed among `vers` under this prefix ("i<item id>"); a numbered version by its plain id. */
	private const ITEM = 'i';

	public function __construct(private IDBConnection $db) {
	}

	/** @return array<int, list<string>> every collection the user owns -> its secret field keys (maybe none) */
	public function ownedKeys(string $uid): array {
		$q = $this->db->getQueryBuilder();
		$q->select('c.id', 'f.field_key', 'f.secret')->from('regibase_collections', 'c')
			->leftJoin('c', 'regibase_fields', 'f', $q->expr()->eq('f.collection_id', 'c.id'))
			->where($q->expr()->eq('c.user_id', $q->createNamedParameter($uid)));
		$map = [];
		foreach ($q->executeQuery()->fetchAll() as $row) {
			$cid = (int)$row['id'];
			$map[$cid] ??= [];
			if (!empty($row['secret']) && $row['field_key'] !== null) {
				$map[$cid][] = (string)$row['field_key'];
			}
		}
		return $map;
	}

	/** The values of $data a key change must see. */
	public static function pick(array $data, array $keys): array {
		$out = [];
		foreach ($data as $k => $v) {
			if (is_string($v) && $v !== '' && (in_array((string)$k, $keys, true) || str_starts_with($v, self::ENC))) {
				$out[(string)$k] = $v;
			}
		}
		return $out;
	}

	/** Whether $key of $current may be written by a key change. */
	public static function mayWrite(array $current, string $key, array $keys): bool {
		return in_array($key, $keys, true) || (is_string($current[$key] ?? null) && str_starts_with($current[$key], self::ENC));
	}

	/**
	 * @return array{vers: list<array>, hist: list<array>, wraps: array<string, string>}
	 *   vers: {ref: version id, or "i<item id>" for a version-by-session item, collection, data};
	 *   hist: {ref: "row:spot", collection, data};
	 *   wraps: the own key of a deleted collection kept in the history, under "h<row>".
	 */
	public function collect(string $uid): array {
		$map = $this->ownedKeys($uid);
		$vers = [];
		foreach ($this->versionRows(array_keys($map)) as $row) {
			$snap = json_decode((string)$row['data'], true);
			$data = is_array($snap['data'] ?? null) ? $snap['data'] : [];
			$picked = self::pick($data, $map[(int)$row['collection_id']] ?? []);
			if ($picked) {
				$vers[] = ['ref' => (int)$row['id'], 'collection' => (int)$row['collection_id'], 'data' => $picked];
			}
		}
		// the versions by session: the record as it was before the session touched it
		foreach ($this->itemRows(array_keys($map)) as $row) {
			$picked = self::pick(self::itemData((string)$row['data']), $map[(int)$row['collection_id']] ?? []);
			if ($picked) {
				$vers[] = ['ref' => self::ITEM . $row['id'], 'collection' => (int)$row['collection_id'], 'data' => $picked];
			}
		}
		$hist = [];
		$wraps = [];
		foreach ($this->historyRows($uid, array_keys($map)) as $row) {
			$p = json_decode((string)$row['undo_data'], true);
			if (!is_array($p)) {
				continue;
			}
			foreach ($this->spots($row, $p, $uid, $map) as $i => [$path, $coll, $keys]) {
				$data = $this->at($p, $path);
				$picked = is_array($data) ? self::pick($data, $keys) : [];
				if ($picked) {
					$hist[] = ['ref' => $row['id'] . ':' . $i, 'collection' => $coll, 'data' => $picked];
				}
			}
			$w = $p['dump']['settings']['key_wrap'] ?? '';
			if (($p['kind'] ?? '') === 'recreate_collection' && $row['user_id'] === $uid && is_string($w) && $w !== '') {
				$wraps['h' . $row['id']] = $w;
			}
		}
		return ['vers' => $vers, 'hist' => $hist, 'wraps' => $wraps];
	}

	/**
	 * Check the page's answer and build the rows to write, without writing anything yet.
	 * @return list<array{0: string, 1: string, 2: int, 3: string}> [table, column, id, new json value]
	 */
	public function plan(string $uid, array $vers, array $hist, array $histWraps): array {
		$map = $this->ownedKeys($uid);
		$out = [];
		$byId = [];
		foreach ($this->versionRows(array_keys($map)) as $row) {
			$byId[(int)$row['id']] = $row;
		}
		$itemById = [];
		foreach ($this->itemRows(array_keys($map)) as $row) {
			$itemById[(int)$row['id']] = $row;
		}
		foreach ($vers as $it) {
			$ref = $it['ref'] ?? 0;
			if (is_string($ref) && str_starts_with($ref, self::ITEM)) {
				// a version-by-session item: the record data is a JSON string inside its JSON
				$id = (int)substr($ref, strlen(self::ITEM));
				if (!isset($itemById[$id]) || !is_array($it['data'] ?? null)) {
					throw new \InvalidArgumentException('Bad version: ' . $ref);
				}
				$pre = json_decode((string)$itemById[$id]['data'], true) ?: [];
				$data = self::itemData((string)$itemById[$id]['data']);
				$pre['data'] = json_encode($this->merge($data, $it['data'], $map[(int)$itemById[$id]['collection_id']] ?? []), JSON_UNESCAPED_UNICODE);
				$out[] = ['regibase_version_items', 'data', $id, json_encode($pre, JSON_UNESCAPED_UNICODE)];
				continue;
			}
			$id = (int)$ref;
			if (!isset($byId[$id]) || !is_array($it['data'] ?? null)) {
				throw new \InvalidArgumentException('Bad version: ' . $id);
			}
			$snap = json_decode((string)$byId[$id]['data'], true) ?: [];
			$data = is_array($snap['data'] ?? null) ? $snap['data'] : [];
			$snap['data'] = $this->merge($data, $it['data'], $map[(int)$byId[$id]['collection_id']] ?? []);
			$out[] = ['regibase_rec_vers', 'data', $id, json_encode($snap, JSON_UNESCAPED_UNICODE)];
		}
		$rows = [];
		foreach ($this->historyRows($uid, array_keys($map)) as $row) {
			$rows[(int)$row['id']] = $row;
		}
		$work = [];
		foreach ($hist as $it) {
			[$rid, $spot] = array_map('intval', explode(':', (string)($it['ref'] ?? '0:0')) + [1 => -1]);
			if (!isset($rows[$rid]) || !is_array($it['data'] ?? null)) {
				throw new \InvalidArgumentException('Bad history entry: ' . ($it['ref'] ?? ''));
			}
			$work[$rid][$spot] = $it['data'];
		}
		foreach ($histWraps as $ref => $wrap) {
			$rid = (int)substr((string)$ref, 1);
			// only a deleted collection's own key, kept in its recreate_collection entry, and only
			// a string or nothing (review, second look)
			$kind = isset($rows[$rid]) ? (json_decode((string)$rows[$rid]['undo_data'], true)['kind'] ?? '') : '';
			if (!isset($rows[$rid]) || $rows[$rid]['user_id'] !== $uid || $kind !== 'recreate_collection'
				|| !($wrap === null || is_string($wrap))) {
				throw new \InvalidArgumentException('Bad history key: ' . $ref);
			}
			$work[$rid] ??= [];
		}
		foreach ($work as $rid => $spots) {
			$p = json_decode((string)$rows[$rid]['undo_data'], true);
			$all = $this->spots($rows[$rid], $p, $uid, $map);
			foreach ($spots as $i => $data) {
				if (!isset($all[$i])) {
					throw new \InvalidArgumentException('Bad history entry: ' . $rid . ':' . $i);
				}
				[$path, , $keys] = $all[$i];
				$cur = $this->at($p, $path);
				$this->put($p, $path, $this->merge(is_array($cur) ? $cur : [], $data, $keys));
			}
			if (array_key_exists('h' . $rid, $histWraps)) {
				$w = $histWraps['h' . $rid];
				$p['dump']['settings']['key_wrap'] = ($w === null || $w === '') ? null : (string)$w;
			}
			$out[] = ['regibase_history', 'undo_data', $rid, json_encode($p, JSON_UNESCAPED_UNICODE)];
		}
		return $out;
	}

	/** Write what plan() built. The caller holds the transaction. */
	public function write(array $plan): void {
		foreach ($plan as [$table, $col, $id, $json]) {
			$q = $this->db->getQueryBuilder();
			$q->update($table)->set($col, $q->createNamedParameter($json))
				->where($q->expr()->eq('id', $q->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
				->executeStatement();
		}
	}

	private function merge(array $cur, array $new, array $keys): array {
		foreach ($new as $k => $v) {
			$k = (string)$k;
			if (!is_string($v) || !self::mayWrite($cur, $k, $keys)) {
				throw new \InvalidArgumentException('Bad field: ' . $k);
			}
			if ($v === '') {
				unset($cur[$k]);
			} else {
				$cur[$k] = $v;
			}
		}
		return $cur;
	}

	/**
	 * Where record data sits in one history row, and whose key it is under.
	 * Only data of the user's own collections is listed; a deleted collection's data
	 * counts when this user deleted it (it was theirs).
	 * @return list<array{0: list<string|int>, 1: int|string, 2: list<string>}>
	 */
	private function spots(array $row, array $p, string $uid, array $map): array {
		$out = [];
		$add = function (array $path, $cid) use (&$out, $map) {
			if (isset($map[(int)$cid])) {
				$out[] = [$path, (int)$cid, $map[(int)$cid]];
			}
		};
		switch ($p['kind'] ?? '') {
			case 'set_data':
				$add(['data'], (int)$row['collection_id']);
				break;
			case 'reinsert':
				$add(['record', 'data'], (int)($p['record']['collectionId'] ?? 0));
				break;
			case 'reinsert_many':
				foreach (($p['records'] ?? []) as $i => $r) {
					$add(['records', $i, 'data'], (int)($r['collectionId'] ?? 0));
				}
				break;
			case 'undo_transfer':
				foreach (($p['restore'] ?? []) as $i => $r) {
					$add(['restore', $i, 'data'], (int)($r['collectionId'] ?? 0));
				}
				break;
			case 'recreate_collection':
				if ($row['user_id'] !== $uid) {
					break;
				}
				$keys = [];
				foreach (($p['dump']['fields'] ?? []) as $f) {
					if (!empty($f['secret']) && isset($f['key'])) {
						$keys[] = (string)$f['key'];
					}
				}
				foreach (($p['dump']['records'] ?? []) as $i => $r) {
					$out[] = [['dump', 'records', $i, 'data'], 'h' . $row['id'], $keys];
				}
				break;
		}
		return $out;
	}

	private function at(array $p, array $path) {
		foreach ($path as $k) {
			if (!is_array($p) || !array_key_exists($k, $p)) {
				return null;
			}
			$p = $p[$k];
		}
		return $p;
	}

	private function put(array &$p, array $path, array $value): void {
		$ref = &$p;
		foreach ($path as $k) {
			$ref = &$ref[$k];
		}
		$ref = $value;
	}

	private function versionRows(array $cids): array {
		$rows = [];
		foreach (array_chunk($cids, 500) as $chunk) {
			$q = $this->db->getQueryBuilder();
			$q->select('v.id', 'v.data', 'r.collection_id')->from('regibase_rec_vers', 'v')
				->innerJoin('v', 'regibase_records', 'r', $q->expr()->eq('r.id', 'v.record_id'))
				->where($q->expr()->in('r.collection_id', $q->createNamedParameter($chunk, IQueryBuilder::PARAM_INT_ARRAY)));
			array_push($rows, ...$q->executeQuery()->fetchAll());
		}
		return $rows;
	}

	/** The items of the versions by session that keep a record as it was ("pre"), for these collections. */
	private function itemRows(array $cids): array {
		$rows = [];
		foreach (array_chunk($cids, 500) as $chunk) {
			$q = $this->db->getQueryBuilder();
			$q->select('i.id', 'i.data', 'v.collection_id')->from('regibase_version_items', 'i')
				->innerJoin('i', 'regibase_versions', 'v', $q->expr()->eq('v.id', 'i.version_id'))
				->where($q->expr()->in('v.collection_id', $q->createNamedParameter($chunk, IQueryBuilder::PARAM_INT_ARRAY)))
				->andWhere($q->expr()->eq('i.kind', $q->createNamedParameter('pre')));
			array_push($rows, ...$q->executeQuery()->fetchAll());
		}
		return $rows;
	}

	/** The record data a version-by-session item keeps: VersionJournal writes it as a JSON string inside the item's JSON. */
	public static function itemData(string $json): array {
		$pre = json_decode($json, true);
		$data = is_array($pre) ? json_decode((string)($pre['data'] ?? '{}'), true) : null;
		return is_array($data) ? $data : [];
	}

	/** The user's own history, and anybody's history about the user's collections. */
	private function historyRows(string $uid, array $cids): array {
		$rows = [];
		$q = $this->db->getQueryBuilder();
		$q->select('id', 'user_id', 'collection_id', 'undo_data')->from('regibase_history')
			->where($q->expr()->eq('user_id', $q->createNamedParameter($uid)));
		foreach ($q->executeQuery()->fetchAll() as $r) {
			$rows[(int)$r['id']] = $r;
		}
		foreach (array_chunk($cids, 500) as $chunk) {
			$q = $this->db->getQueryBuilder();
			$q->select('id', 'user_id', 'collection_id', 'undo_data')->from('regibase_history')
				->where($q->expr()->in('collection_id', $q->createNamedParameter($chunk, IQueryBuilder::PARAM_INT_ARRAY)));
			foreach ($q->executeQuery()->fetchAll() as $r) {
				$rows[(int)$r['id']] = $r;
			}
		}
		return array_values($rows);
	}
}
