<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

/**
 * What a snapshot shows of the change it holds (owner, 2026-11-04: 「何を行ったかがわかるように」).
 *
 * Two halves:
 *  - when a change is recorded, a small "view" is kept beside the undo data (in the same JSON,
 *    under "view"): the new values the undo data does not have, cut short, secret values never;
 *  - when the snapshots are listed, detail() turns the view -- or, for an entry recorded before
 *    views were kept, what its undo data tells -- into what the page shows.
 *
 * A secret value is never put in a view nor shown: not a secret field's value (as it is now or
 * as it was when recorded), not anything that looks like ciphertext. Attachments are only named
 * ("image changed"). Somebody who is not the owner is shown only the collection's current fields.
 * Everything here is plain arrays in, plain arrays out: no database.
 */
final class HistoryView {
	public const ATTACH_TYPES = ['image', 'image_crop', 'file'];
	/** A value is cut to this many characters. */
	public const CUT = 40;
	/** At most this many changed fields are kept per change (the page shows five and "N more"; 6 × two 40-character values stays under 2 KB). */
	public const MAX_CHANGES = 6;
	/** At most this many record titles per bulk change, and field names per field change. */
	public const MAX_TITLES = 3;
	public const MAX_LABELS = 8;
	/** Fields shown under a record that was added. */
	public const MAX_RECORD_FIELDS = 3;
	/** Collection settings whose change is named (the values are not shown, but the name's). */
	public const SETTINGS = ['name', 'icon', 'color', 'description', 'locked', 'key_head', 'key_sep',
		'key_sep_char', 'files_folder', 'map_provider', 'secret'];

	public static function cut(string $s, int $max = self::CUT): string {
		$s = trim(preg_replace('/\s+/u', ' ', $s) ?? $s);
		return mb_strlen($s) > $max ? mb_substr($s, 0, $max - 1) . '…' : $s;
	}

	/** A value as text (a list of choices joined), or null when there is nothing to show. */
	private static function text($v): ?string {
		if (is_array($v)) {
			$v = implode(', ', array_map(static fn ($x) => is_scalar($x) ? (string)$x : '', $v));
		}
		if ($v === null || !is_scalar($v)) {
			return null;
		}
		$s = is_bool($v) ? ($v ? '1' : '') : (string)$v;
		return $s === '' ? null : $s;
	}

	private static function looksEncrypted($v): bool {
		return is_string($v) && str_starts_with($v, 'rbenc1:');
	}

	/** @return array<string,array> fields by key */
	private static function byKey(array $fields): array {
		$out = [];
		foreach ($fields as $f) {
			if (is_array($f) && isset($f['key'])) {
				$out[(string)$f['key']] = $f;
			}
		}
		return $out;
	}

	private static function isAttach(?array $f): bool {
		return $f !== null && in_array((string)($f['type'] ?? ''), self::ATTACH_TYPES, true);
	}

	// ---- when a change is recorded ----

	/** The parts of a record's title: [[key, value], ...], secret and attachment fields left out. */
	public static function titleParts(array $fields, array $data): array {
		$usable = static fn (array $f) => empty($f['secret']) && !self::isAttach($f)
			&& self::text($data[$f['key']] ?? null) !== null && !self::looksEncrypted($data[$f['key']] ?? null);
		$parts = [];
		foreach ($fields as $f) {
			if (is_array($f) && !empty($f['is_title']) && $usable($f)) {
				$parts[] = [(string)$f['key'], self::cut((string)self::text($data[$f['key']]))];
			}
		}
		if ($parts === []) {
			foreach ($fields as $f) {
				if (is_array($f) && $usable($f)) {
					return [[(string)$f['key'], self::cut((string)self::text($data[$f['key']]))]];
				}
			}
		}
		return $parts;
	}

	/** A record that was added: its title and its first few fields, none of them secret. */
	public static function recordView(array $fields, array $data): array {
		$title = self::titleParts($fields, $data);
		$inTitle = array_flip(array_map(static fn ($p) => $p[0], $title));
		$shown = [];
		foreach ($fields as $f) {
			if (count($shown) >= self::MAX_RECORD_FIELDS) {
				break;
			}
			$k = (string)($f['key'] ?? '');
			$v = $data[$k] ?? null;
			if ($k === '' || isset($inTitle[$k]) || !empty($f['secret']) || self::isAttach($f)
				|| self::looksEncrypted($v) || self::text($v) === null) {
				continue;
			}
			$shown[] = ['k' => $k, 'l' => self::cut((string)($f['label'] ?? $k)), 'v' => self::cut((string)self::text($v))];
		}
		return ['t' => $title, 'f' => $shown];
	}

	/**
	 * What one edit changed, field by field: [k, label, old, new], or the field marked secret
	 * ("s") or an attachment ("a") with no value. At most MAX_CHANGES are kept; "n" is how many changed.
	 */
	public static function editView(array $fields, array $old, array $new): array {
		$changes = [];
		$n = 0;
		foreach ($fields as $f) {
			$k = (string)($f['key'] ?? '');
			if ($k === '') {
				continue;
			}
			$o = $old[$k] ?? null;
			$v = $new[$k] ?? null;
			if (self::text($o) === self::text($v)) {
				continue;
			}
			$n++;
			if (count($changes) >= self::MAX_CHANGES) {
				continue;
			}
			$c = ['k' => $k, 'l' => self::cut((string)($f['label'] ?? $k))];
			if (!empty($f['secret']) || self::looksEncrypted($o) || self::looksEncrypted($v)) {
				$c['s'] = 1;
			} elseif (self::isAttach($f)) {
				$c['a'] = 1;
			} else {
				$c['o'] = self::text($o) === null ? '' : self::cut((string)self::text($o));
				$c['n'] = self::text($v) === null ? '' : self::cut((string)self::text($v));
			}
			$changes[] = $c;
		}
		return ['c' => $changes, 'n' => $n];
	}

	/** Records of a bulk change: how many, and the first few titles. */
	public static function bulkView(array $fields, array $dataList): array {
		$t = [];
		foreach (array_slice($dataList, 0, self::MAX_TITLES) as $d) {
			$t[] = self::titleParts($fields, is_array($d) ? $d : []);
		}
		return ['n' => count($dataList), 'ts' => $t];
	}

	/** The fields added, removed and renamed by a change of the form. */
	public static function fieldsView(array $before, array $after): array {
		$b = self::byKey($before);
		$a = self::byKey($after);
		$added = $removed = $renamed = $changed = [];
		foreach ($a as $k => $f) {
			if (!isset($b[$k])) {
				$added[] = self::cut((string)($f['label'] ?? $k));
			} elseif ((string)($b[$k]['label'] ?? '') !== (string)($f['label'] ?? '')) {
				$renamed[] = [self::cut((string)($b[$k]['label'] ?? $k)), self::cut((string)($f['label'] ?? $k))];
			} elseif ((string)($b[$k]['type'] ?? '') !== (string)($f['type'] ?? '') || !empty($b[$k]['secret']) !== !empty($f['secret'])) {
				$changed[] = self::cut((string)($f['label'] ?? $k));
			}
		}
		foreach ($b as $k => $f) {
			if (!isset($a[$k])) {
				$removed[] = self::cut((string)($f['label'] ?? $k));
			}
		}
		return array_filter([
			'add' => array_slice($added, 0, self::MAX_LABELS),
			'del' => array_slice($removed, 0, self::MAX_LABELS),
			'ren' => array_slice($renamed, 0, self::MAX_LABELS),
			'chg' => array_slice($changed, 0, self::MAX_LABELS),
		]);
	}

	/** The collection settings a change touched (names only; the collection's name with its values). */
	public static function settingsView(array $before, array $patch): array {
		$keys = [];
		foreach (self::SETTINGS as $k) {
			if ($k === 'secret' && (array_key_exists('secret_pin', $patch) && trim((string)$patch['secret_pin']) !== '')) {
				$keys[] = 'secret';
				continue;
			}
			if (array_key_exists($k, $patch) && self::text($patch[$k]) !== self::text($before[$k] ?? null)) {
				$keys[] = $k;
			}
		}
		$out = ['s' => array_values(array_unique($keys))];
		if (in_array('name', $keys, true)) {
			$out['nm'] = [self::cut((string)($before['name'] ?? '')), self::cut((string)$patch['name'])];
		}
		return $out;
	}

	// ---- when the snapshots are listed ----

	/**
	 * What the page shows for one snapshot, or null for nothing beyond its summary.
	 *
	 * @param array $p       the entry's undo data (with its "view" when it has one)
	 * @param array $fields  the collection's fields as they are now
	 * @param bool  $isOwner whether the viewer owns the collection
	 * @param array|null $current the record as it is now, for an edit or an addition recorded
	 *                            before views were kept (null when it is gone)
	 */
	public static function detail(string $op, array $p, array $fields, bool $isOwner, ?array $current = null): ?array {
		$now = self::byKey($fields);
		$view = is_array($p['view'] ?? null) ? $p['view'] : null;
		$kind = (string)($p['kind'] ?? '');
		switch ($kind) {
			case 'set_data':
				if ($view !== null) {
					return self::editOut($view['c'] ?? [], (int)($view['n'] ?? 0), $now, $isOwner, false);
				}
				// before views: the old values of the fields that differ from the record now
				if ($current === null) {
					return null;
				}
				$old = is_array($p['data'] ?? null) ? $p['data'] : [];
				$v = self::editView($fields, $old, $current);
				foreach ($v['c'] as &$c) {
					unset($c['n']);
				}
				unset($c);
				return self::editOut($v['c'], $v['n'], $now, $isOwner, true);
			case 'del_record':
				$rv = $view ?? ($current !== null ? self::recordView($fields, $current) : null);
				if ($rv === null) {
					return null;
				}
				return array_filter(['kind' => 'add', 'title' => self::titleOut($rv['t'] ?? [], $now, $isOwner),
					'fields' => self::fieldsOut($rv['f'] ?? [], $now, $isOwner)], static fn ($x) => $x !== '' && $x !== []);
			case 'reinsert':
				$d = is_array($p['record']['data'] ?? null) ? $p['record']['data'] : [];
				return ['kind' => 'delete', 'count' => 1, 'titles' => [self::titleOut(self::titleParts($fields, $d), $now, $isOwner)]];
			case 'reinsert_many':
				$recs = is_array($p['records'] ?? null) ? $p['records'] : [];
				$bv = self::bulkView($fields, array_map(static fn ($r) => is_array($r['data'] ?? null) ? $r['data'] : [], $recs));
				return ['kind' => 'delete', 'count' => $bv['n'], 'titles' => self::titlesOut($bv['ts'], $now, $isOwner)];
			case 'del_many':
				$n = $view !== null ? (int)($view['n'] ?? 0) : count(is_array($p['ids'] ?? null) ? $p['ids'] : []);
				return ['kind' => 'import', 'count' => $n, 'titles' => self::titlesOut($view['ts'] ?? [], $now, $isOwner)];
			case 'reorder':
				return ['kind' => 'reorder', 'count' => count(is_array($p['orders'] ?? null) ? $p['orders'] : [])];
			case 'undo_transfer':
				$move = $view !== null ? (($view['m'] ?? '') === 'move') : !empty($p['restore']);
				return array_filter(['kind' => 'transfer', 'mode' => $move ? 'move' : 'copy',
					'count' => $view !== null ? (int)($view['n'] ?? 0) : count(is_array($p['createdIds'] ?? null) ? $p['createdIds'] : []),
					'from' => (string)($view['from'] ?? ''), 'to' => (string)($view['to'] ?? '')], static fn ($x) => $x !== '');
			case 'none':
				// the half of a move kept in the collection it left
				return $view !== null ? array_filter(['kind' => 'transfer', 'mode' => 'move', 'count' => (int)($view['n'] ?? 0),
					'to' => (string)($view['to'] ?? '')], static fn ($x) => $x !== '') : null;
			case 'restore_fields':
				return $view !== null ? ['kind' => 'fields'] + array_filter([
					'added' => $view['add'] ?? [], 'removed' => $view['del'] ?? [],
					'renamed' => $view['ren'] ?? [], 'changed' => $view['chg'] ?? []]) : null;
			case 'restore_collection':
				return $view !== null ? array_filter(['kind' => 'settings', 'settings' => $view['s'] ?? [],
					'name' => $view['nm'] ?? []]) + ['kind' => 'settings'] : null;
			case 'recreate_collection':
				$dump = is_array($p['dump'] ?? null) ? $p['dump'] : [];
				return ['kind' => 'collection', 'count' => count(is_array($dump['records'] ?? null) ? $dump['records'] : []),
					'nfields' => count(is_array($dump['fields'] ?? null) ? $dump['fields'] : [])];
		}
		return null;
	}

	/**
	 * Whether a field's value may be shown now: never a secret field's (as it is now or was
	 * marked), never ciphertext, and to somebody who is not the owner only a field the
	 * collection still has.
	 */
	private static function shown(string $k, array $now, bool $isOwner, bool $wasSecret = false, ...$values): bool {
		if ($wasSecret || !empty($now[$k]['secret'])) {
			return false;
		}
		if (!$isOwner && !isset($now[$k])) {
			return false;
		}
		foreach ($values as $v) {
			if (self::looksEncrypted($v)) {
				return false;
			}
		}
		return true;
	}

	private static function label(string $k, array $now, string $stored): string {
		return isset($now[$k]['label']) && (string)$now[$k]['label'] !== '' ? self::cut((string)$now[$k]['label']) : ($stored !== '' ? $stored : $k);
	}

	private static function editOut(array $changes, int $n, array $now, bool $isOwner, bool $before): array {
		$out = [];
		$dropped = 0;
		foreach ($changes as $c) {
			$k = (string)($c['k'] ?? '');
			if (!$isOwner && !isset($now[$k])) {
				$dropped++;   // a field the viewer does not have now: not even its name
				continue;
			}
			$row = ['label' => self::label($k, $now, (string)($c['l'] ?? ''))];
			if (!empty($c['s']) || !self::shown($k, $now, $isOwner, false, $c['o'] ?? null, $c['n'] ?? null)) {
				$row['secret'] = true;
			} elseif (!empty($c['a']) || self::isAttach($now[$k] ?? null)) {
				$row['attach'] = (string)($now[$k]['type'] ?? 'file') === 'file' ? 'file' : 'image';
			} else {
				$row['old'] = (string)($c['o'] ?? '');
				if ($before) {
					$row['before'] = true;
				} else {
					$row['new'] = (string)($c['n'] ?? '');
				}
			}
			$out[] = $row;
		}
		$shown = array_slice($out, 0, 5);
		$more = max(0, $n - $dropped - count($shown));
		return array_filter(['kind' => 'edit', 'changes' => $shown, 'more' => $more], static fn ($x) => $x !== 0 && $x !== []) + ['kind' => 'edit'];
	}

	private static function titleOut(array $parts, array $now, bool $isOwner): string {
		$vals = [];
		foreach ($parts as $p) {
			if (is_array($p) && count($p) >= 2 && self::shown((string)$p[0], $now, $isOwner, false, $p[1])) {
				$vals[] = (string)$p[1];
			}
		}
		return implode(' ', $vals);
	}

	private static function titlesOut(array $list, array $now, bool $isOwner): array {
		$out = [];
		foreach (array_slice($list, 0, self::MAX_TITLES) as $parts) {
			$t = self::titleOut(is_array($parts) ? $parts : [], $now, $isOwner);
			if ($t !== '') {
				$out[] = $t;
			}
		}
		return $out;
	}

	private static function fieldsOut(array $list, array $now, bool $isOwner): array {
		$out = [];
		foreach ($list as $f) {
			$k = (string)($f['k'] ?? '');
			if ($k !== '' && self::shown($k, $now, $isOwner, false, $f['v'] ?? null) && !self::isAttach($now[$k] ?? null)) {
				$out[] = ['label' => self::label($k, $now, (string)($f['l'] ?? '')), 'value' => (string)($f['v'] ?? '')];
			}
		}
		return $out;
	}
}
