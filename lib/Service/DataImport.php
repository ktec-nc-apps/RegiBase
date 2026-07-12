<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCP\IL10N;

/** Detects CSV vs JSON and delegates to the matching importer. */
class DataImport {
	public static function analyze(string $text, IL10N $l): array {
		if (JsonImport::looksLikeJson($text)) {
			return JsonImport::analyze($text, $l);
		}
		return CsvImport::analyze($text, $l);
	}

	/** @return array{fields: array, records: array} */
	public static function buildRecords(string $text, array $columns): array {
		if (JsonImport::looksLikeJson($text)) {
			return JsonImport::buildRecords($text, $columns);
		}
		return CsvImport::buildRecords($text, $columns);
	}
}
