<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

/**
 * CSV import: parse arbitrary CSV, auto-detect known formats (e.g. Google
 * Password Manager), infer a field schema, and build a collection from it.
 * Ported from the standalone RegiBase (src/import.ts).
 */
class CsvImport {
	private const SECRET_RE = '/pass|pwd|pin|cvc|cvv|secret|token|暗証|パスワード|セキュリティ/iu';
	private const URL_RE = '/\burl\b|website|link|サイト|homepage/iu';
	private const EMAIL_RE = '/e?-?mail|メール/iu';
	private const NOTE_RE = '/note|memo|comment|備考|メモ|摘要/iu';
	private const TEL_RE = '/\btel\b|phone|mobile|電話/iu';
	private const DATE_RE = '/date|期限|日付|発行日/iu';

	/** RFC4180-ish CSV parser (quotes, escaped "", CRLF, newlines in quotes). */
	public static function parseCsv(string $text): array {
		$rows = [];
		$field = '';
		$row = [];
		$inQuotes = false;
		$i = 0;
		$n = strlen($text);
		// strip UTF-8 BOM
		if ($n >= 3 && substr($text, 0, 3) === "\xEF\xBB\xBF") {
			$i = 3;
		}
		while ($i < $n) {
			$c = $text[$i];
			if ($inQuotes) {
				if ($c === '"') {
					if ($i + 1 < $n && $text[$i + 1] === '"') { $field .= '"'; $i += 2; continue; }
					$inQuotes = false; $i++; continue;
				}
				$field .= $c; $i++; continue;
			}
			if ($c === '"') { $inQuotes = true; $i++; continue; }
			if ($c === ',') { $row[] = $field; $field = ''; $i++; continue; }
			if ($c === "\r") { $i++; continue; }
			if ($c === "\n") { $row[] = $field; $rows[] = $row; $row = []; $field = ''; $i++; continue; }
			$field .= $c; $i++;
		}
		if ($field !== '' || count($row) > 0) { $row[] = $field; $rows[] = $row; }
		return $rows;
	}

	private static function nonEmptyRows(array $rows): array {
		return array_values(array_filter($rows, function ($r) {
			foreach ($r as $c) {
				if (trim($c) !== '') { return true; }
			}
			return false;
		}));
	}

	public static function slugKey(string $s, int $fallbackIndex): string {
		$base = mb_strtolower(trim($s));
		$base = preg_replace('/[^a-z0-9぀-ヿ一-鿿]+/u', '_', $base);
		$base = trim((string)$base, '_');
		return $base !== '' ? $base : ('col_' . ($fallbackIndex + 1));
	}

	public static function isSecret(string $header): bool {
		return (bool)preg_match(self::SECRET_RE, $header);
	}

	public static function inferType(string $header, bool $secret): string {
		if ($secret) { return 'password'; }
		if (preg_match(self::URL_RE, $header)) { return 'url'; }
		if (preg_match(self::EMAIL_RE, $header)) { return 'email'; }
		if (preg_match(self::NOTE_RE, $header)) { return 'textarea'; }
		if (preg_match(self::TEL_RE, $header)) { return 'tel'; }
		if (preg_match(self::DATE_RE, $header)) { return 'date'; }
		return 'text';
	}

	/** Known-format recognizers keyed by header signature. */
	private static function recognizers(): array {
		return [
			[
				'format' => 'google_passwords',
				'formatLabel' => 'Google Password Manager',
				'name' => 'Passwords (Google import)',
				'icon' => '🔐',
				'color' => '#2563eb',
				'signature' => ['name', 'url', 'username', 'password'],
				'map' => [
					'name' => ['label' => 'Service name', 'type' => 'text', 'title' => true],
					'url' => ['label' => 'URL', 'type' => 'url'],
					'username' => ['label' => 'Username', 'type' => 'text'],
					'password' => ['label' => 'Password', 'type' => 'password', 'secret' => true],
					'note' => ['label' => 'Memo', 'type' => 'textarea'],
				],
			],
		];
	}

	public static function analyze(string $csv, \OCP\IL10N $l): array {
		$rows = self::nonEmptyRows(self::parseCsv($csv));
		if (count($rows) === 0) {
			throw new \RuntimeException('The CSV is empty');
		}
		$headers = array_map('trim', $rows[0]);
		$dataRows = array_slice($rows, 1);
		$lowered = array_map('mb_strtolower', $headers);

		$rec = null;
		foreach (self::recognizers() as $r) {
			$ok = true;
			foreach ($r['signature'] as $s) {
				if (!in_array($s, $lowered, true)) { $ok = false; break; }
			}
			if ($ok) { $rec = $r; break; }
		}

		$columns = [];
		foreach ($headers as $index => $header) {
			$low = mb_strtolower($header);
			$override = ($rec && isset($rec['map'][$low])) ? $rec['map'][$low] : null;
			$secret = $override['secret'] ?? (bool)preg_match(self::SECRET_RE, $header);
			$columns[] = [
				'index' => $index,
				'header' => $header,
				'key' => self::slugKey($header, $index),
				'label' => isset($override['label']) ? $l->t($override['label']) : ($header !== '' ? $header : ($l->t('Column') . ($index + 1))),
				'type' => $override['type'] ?? self::inferType($header, $secret),
				'secret' => $secret,
				'is_title' => $override['title'] ?? false,
			];
		}
		// ensure exactly one title
		$hasTitle = false;
		foreach ($columns as $c) {
			if ($c['is_title']) { $hasTitle = true; break; }
		}
		if (!$hasTitle && count($columns) > 0) {
			$columns[0]['is_title'] = true;
		}

		return [
			'format' => $rec['format'] ?? 'generic',
			'formatLabel' => $l->t($rec['formatLabel'] ?? 'Generic CSV'),
			'suggestedName' => $l->t($rec['name'] ?? 'Imported data'),
			'suggestedIcon' => $rec['icon'] ?? '📥',
			'suggestedColor' => $rec['color'] ?? '#0ea5e9',
			'columns' => $columns,
			'rowCount' => count($dataRows),
			'sample' => array_slice($dataRows, 0, 5),
		];
	}

	/**
	 * Build the field list + record data arrays from csv + chosen columns.
	 * @return array{fields: array, records: array}
	 */
	public static function buildRecords(string $csv, array $columns): array {
		$rows = self::nonEmptyRows(self::parseCsv($csv));
		$dataRows = array_slice($rows, 1);
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
		foreach ($dataRows as $r) {
			$data = [];
			foreach ($columns as $c) {
				$v = isset($r[$c['index']]) ? trim($r[$c['index']]) : '';
				if ($v !== '') { $data[$c['key']] = $v; }
			}
			$records[] = $data;
		}
		return ['fields' => $fields, 'records' => $records];
	}
}
