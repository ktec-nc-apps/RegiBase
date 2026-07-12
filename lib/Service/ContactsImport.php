<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCP\IL10N;

/**
 * Maps Nextcloud Contacts (vCard property arrays from IManager/IAddressBook::search)
 * into RegiBase records. Import only — RegiBase never writes back to Contacts.
 */
class ContactsImport {
	/** Field schema for a contacts collection (labels reuse existing i18n keys). */
	public static function fields(IL10N $l): array {
		return [
			['key' => 'name', 'label' => $l->t('氏名'), 'type' => 'text', 'is_title' => true, 'required' => true],
			['key' => 'reading', 'label' => $l->t('ふりがな'), 'type' => 'text'],
			['key' => 'photo', 'label' => $l->t('顔写真'), 'type' => 'image'],
			['key' => 'company', 'label' => $l->t('会社名'), 'type' => 'text'],
			['key' => 'mobile', 'label' => $l->t('携帯電話'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
			['key' => 'phone', 'label' => $l->t('電話'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
			['key' => 'email', 'label' => $l->t('メール'), 'type' => 'email'],
			['key' => 'address', 'label' => $l->t('住所'), 'type' => 'textarea'],
			['key' => 'birthday', 'label' => $l->t('誕生日'), 'type' => 'date'],
			['key' => 'memo', 'label' => $l->t('メモ'), 'type' => 'textarea'],
		];
	}

	/** Convert one contact (property array) to a record data array, or null to skip. */
	public static function toRecord(array $c): ?array {
		$name = self::first($c, 'FN');
		if ($name === '') {
			$name = trim(str_replace([';', '  '], ' ', self::first($c, 'N')));
		}
		if ($name === '') {
			return null;
		}

		$mobile = '';
		$phone = '';
		foreach (self::values($c, 'TEL') as $t) {
			$isCell = false;
			foreach ($t['types'] as $ty) {
				if (stripos($ty, 'CELL') !== false || stripos($ty, 'MOBILE') !== false) {
					$isCell = true;
				}
			}
			if ($isCell) {
				if ($mobile === '') {
					$mobile = $t['value'];
				}
			} elseif ($phone === '') {
				$phone = $t['value'];
			}
		}
		$allTels = self::values($c, 'TEL');
		if ($mobile === '' && $phone === '' && count($allTels) > 0) {
			$phone = $allTels[0]['value'];
		}

		$reading = trim(self::first($c, 'X-PHONETIC-LAST-NAME') . ' ' . self::first($c, 'X-PHONETIC-FIRST-NAME'));
		$data = [
			'name' => $name,
			'reading' => $reading,
			'company' => trim(str_replace(';', ' ', self::first($c, 'ORG'))),
			'mobile' => $mobile,
			'phone' => $phone,
			'email' => self::first($c, 'EMAIL'),
			'address' => self::formatAddress(self::first($c, 'ADR')),
			'birthday' => self::normalizeDate(self::first($c, 'BDAY')),
			'memo' => self::first($c, 'NOTE'),
		];
		return array_filter($data, static fn ($v) => $v !== '' && $v !== null);
	}

	/**
	 * Pull the raw PHOTO property value out of a stored vCard.
	 * (IManager::search externalises photos to a URI, so we read the raw card.)
	 */
	public static function photoValueFromVcard(string $vcard): string {
		// unfold continuation lines (CRLF/LF + space/tab)
		$unfolded = preg_replace('/\r?\n[ \t]/', '', $vcard);
		if ($unfolded === null) {
			return '';
		}
		foreach (preg_split('/\r?\n/', $unfolded) as $line) {
			if (preg_match('/^PHOTO[;:]/i', $line)) {
				$pos = strpos($line, ':');
				if ($pos !== false) {
					$val = substr($line, $pos + 1);
					// skip external URI references (no embedded image data)
					if (stripos(substr($line, 0, $pos), 'VALUE=uri') !== false && stripos($val, 'data:') !== 0) {
						return '';
					}
					return $val;
				}
			}
		}
		return '';
	}

	/**
	 * Decode a PHOTO value (data: URI or base64/binary) to image bytes.
	 * Format is identified from the binary magic bytes.
	 * @return array{ext:string,data:string}|null
	 */
	public static function decodePhoto(string $val): ?array {
		$val = trim($val);
		if ($val === '') {
			return null;
		}
		$bin = null;
		if (stripos($val, 'data:') === 0) {
			if (preg_match('#^data:[^,]*;base64,(.*)$#s', $val, $m)) {
				$bin = base64_decode($m[1], true);
			}
		} else {
			$stripped = preg_replace('/\s+/', '', $val);
			$decoded = $stripped !== null ? base64_decode($stripped, true) : false;
			if ($decoded !== false && self::imageExt($decoded) !== '') {
				$bin = $decoded;
			} elseif (self::imageExt($val) !== '') {
				$bin = $val; // already binary
			}
		}
		if ($bin === null || $bin === false) {
			return null;
		}
		$ext = self::imageExt($bin);
		if ($ext === '' || strlen($bin) > 20 * 1024 * 1024) {
			return null;
		}
		return ['ext' => $ext, 'data' => $bin];
	}

	/** Image extension from magic bytes, or '' if not a recognised image. */
	private static function imageExt(string $bin): string {
		if (strlen($bin) < 12) {
			return '';
		}
		if (substr($bin, 0, 3) === "\xFF\xD8\xFF") {
			return 'jpg';
		}
		if (substr($bin, 0, 8) === "\x89PNG\x0D\x0A\x1A\x0A") {
			return 'png';
		}
		if (substr($bin, 0, 4) === 'GIF8') {
			return 'gif';
		}
		if (substr($bin, 0, 4) === 'RIFF' && substr($bin, 8, 4) === 'WEBP') {
			return 'webp';
		}
		return '';
	}

	/** First scalar (string) value of a property that may be string / list / {value}. */
	private static function rawScalar($raw): string {
		if (is_string($raw)) {
			return $raw;
		}
		if (is_array($raw)) {
			if (array_key_exists('value', $raw)) {
				return is_array($raw['value']) ? (string)($raw['value'][0] ?? '') : (string)$raw['value'];
			}
			foreach ($raw as $item) {
				if (is_string($item) && $item !== '') {
					return $item;
				}
				if (is_array($item) && array_key_exists('value', $item)) {
					return is_array($item['value']) ? (string)($item['value'][0] ?? '') : (string)$item['value'];
				}
			}
		}
		return '';
	}

	/** ADR "pobox;ext;street;city;region;postal;country" → readable one-line address. */
	private static function formatAddress(string $adr): string {
		if ($adr === '') {
			return '';
		}
		$parts = array_values(array_filter(array_map('trim', explode(';', $adr)), static fn ($p) => $p !== ''));
		return implode(' ', $parts);
	}

	/** Normalise a vCard date (YYYYMMDD / YYYY-MM-DD / with time) to YYYY-MM-DD. */
	private static function normalizeDate(string $v): string {
		$v = trim($v);
		if ($v === '') {
			return '';
		}
		if (preg_match('/(\d{4})-?(\d{2})-?(\d{2})/', $v, $m)) {
			return $m[1] . '-' . $m[2] . '-' . $m[3];
		}
		return '';
	}

	/**
	 * Normalise a property (string | list of strings | {value,type} | list thereof)
	 * into a list of ['value' => string, 'types' => string[]].
	 * @return array<int,array{value:string,types:string[]}>
	 */
	private static function values(array $c, string $key): array {
		if (!isset($c[$key])) {
			return [];
		}
		$raw = $c[$key];
		$items = [];
		$push = static function ($v) use (&$items): void {
			if (is_string($v)) {
				if ($v !== '') {
					$items[] = ['value' => $v, 'types' => []];
				}
				return;
			}
			if (is_array($v)) {
				if (array_key_exists('value', $v)) {
					$val = $v['value'];
					$sval = is_array($val) ? implode(';', array_map('strval', $val)) : (string)$val;
					if ($sval !== '') {
						$items[] = ['value' => $sval, 'types' => self::typeList($v['type'] ?? [])];
					}
				} else {
					// structured components (e.g. N / ADR) → join
					$sval = implode(';', array_map(static fn ($x) => is_array($x) ? implode(',', $x) : (string)$x, $v));
					if (trim($sval, '; ') !== '') {
						$items[] = ['value' => $sval, 'types' => []];
					}
				}
			}
		};
		if (is_string($raw)) {
			$push($raw);
		} elseif (is_array($raw)) {
			if (array_key_exists('value', $raw)) {
				$push($raw);
			} elseif (array_keys($raw) === range(0, count($raw) - 1)) {
				foreach ($raw as $item) {
					$push($item);
				}
			} else {
				$push($raw);
			}
		}
		return $items;
	}

	private static function typeList($t): array {
		if (is_string($t)) {
			return [$t];
		}
		if (is_array($t)) {
			return array_map('strval', $t);
		}
		return [];
	}

	private static function first(array $c, string $key): string {
		$v = self::values($c, $key);
		return $v !== [] ? $v[0]['value'] : '';
	}
}
