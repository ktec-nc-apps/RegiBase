<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

/**
 * JSON import. Accepts either:
 *   - an array of flat objects: [{"name":"...","url":"..."}, ...]
 *   - a RegiBase export object: {"collection":{...},"fields":[...],"records":[...]}
 *   - a single flat object (treated as one record)
 * Produces the same analysis/records contract as CsvImport.
 */
class JsonImport {
	public static function looksLikeJson(string $text): bool {
		$t = ltrim($text);
		return $t !== '' && ($t[0] === '[' || $t[0] === '{');
	}

	private static function decode(string $text) {
		$data = json_decode($text, true);
		if ($data === null && trim($text) !== 'null') {
			throw new \RuntimeException('JSONの解析に失敗しました');
		}
		return $data;
	}

	private static function isList(array $a): bool {
		if (function_exists('array_is_list')) {
			return array_is_list($a);
		}
		return $a === [] || array_keys($a) === range(0, count($a) - 1);
	}

	/** Normalise any accepted shape into [fieldsMeta[]|null, rows[](assoc), formatLabel]. */
	private static function normalise($data): array {
		if (is_array($data) && isset($data['records']) && is_array($data['records'])) {
			// RegiBase export object
			$fields = is_array($data['fields'] ?? null) ? $data['fields'] : null;
			return [$fields, array_values($data['records']), 'RegiBase JSON', $data['collection'] ?? null];
		}
		if (is_array($data) && self::isList($data)) {
			$rows = array_values(array_filter($data, 'is_array'));
			return [null, $rows, 'JSON（配列）', null];
		}
		if (is_array($data)) {
			// single object -> one record
			return [null, [$data], 'JSON（単一オブジェクト）', null];
		}
		throw new \RuntimeException('対応していないJSON形式です');
	}

	private static function scalar($v): string {
		if ($v === null) {
			return '';
		}
		if (is_bool($v)) {
			return $v ? 'true' : 'false';
		}
		if (is_scalar($v)) {
			return (string)$v;
		}
		return json_encode($v, JSON_UNESCAPED_UNICODE);
	}

	public static function analyze(string $text, \OCP\IL10N $l): array {
		[$fields, $rows, $label, $coll] = self::normalise(self::decode($text));

		$columns = [];
		if ($fields !== null) {
			// columns straight from the export's field definitions
			foreach ($fields as $i => $f) {
				$key = (string)($f['key'] ?? ('col_' . ($i + 1)));
				$columns[] = [
					'index' => $i,
					'header' => $key,
					'key' => $key,
					'label' => (string)($f['label'] ?? $key),
					'type' => (string)($f['type'] ?? 'text'),
					'secret' => !empty($f['secret']),
					'is_title' => !empty($f['is_title']),
				];
			}
		} else {
			// derive columns from the union of object keys (first-seen order)
			$seen = [];
			foreach ($rows as $row) {
				foreach (array_keys($row) as $k) {
					if (!isset($seen[$k])) {
						$seen[$k] = true;
					}
				}
			}
			$i = 0;
			foreach (array_keys($seen) as $k) {
				$secret = CsvImport::isSecret($k);
				$columns[] = [
					'index' => $i,
					'header' => $k,
					'key' => CsvImport::slugKey($k, $i),
					'label' => $k,
					'type' => CsvImport::inferType($k, $secret),
					'secret' => $secret,
					'is_title' => false,
				];
				$i++;
			}
		}
		$hasTitle = false;
		foreach ($columns as $c) {
			if ($c['is_title']) { $hasTitle = true; break; }
		}
		if (!$hasTitle && count($columns) > 0) {
			$columns[0]['is_title'] = true;
		}

		$sample = [];
		foreach (array_slice($rows, 0, 5) as $row) {
			$line = [];
			foreach ($columns as $c) {
				$line[] = self::scalar($row[$c['header']] ?? '');
			}
			$sample[] = $line;
		}

		return [
			'format' => 'json',
			'formatLabel' => $l->t($label),
			'suggestedName' => is_array($coll) ? (string)($coll['name'] ?? $l->t('取り込みデータ')) : $l->t('取り込みデータ（JSON）'),
			'suggestedIcon' => is_array($coll) ? (string)($coll['icon'] ?? '📥') : '📥',
			'suggestedColor' => is_array($coll) ? (string)($coll['color'] ?? '#0ea5e9') : '#0ea5e9',
			'columns' => $columns,
			'rowCount' => count($rows),
			'sample' => $sample,
		];
	}

	/** @return array{fields: array, records: array} */
	public static function buildRecords(string $text, array $columns): array {
		[, $rows] = self::normalise(self::decode($text));
		$fields = [];
		foreach ($columns as $c) {
			$fields[] = [
				'key' => $c['key'],
				'label' => $c['label'],
				'type' => $c['type'],
				'secret' => !empty($c['secret']),
				'is_title' => !empty($c['is_title']),
			];
		}
		$records = [];
		foreach ($rows as $row) {
			$data = [];
			foreach ($columns as $c) {
				$v = self::scalar($row[$c['header']] ?? '');
				if ($v !== '') {
					$data[$c['key']] = $v;
				}
			}
			$records[] = $data;
		}
		return ['fields' => $fields, 'records' => $records];
	}
}
