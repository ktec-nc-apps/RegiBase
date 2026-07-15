<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCP\App\IAppManager;
use OCP\Server;

/**
 * Bridge to the Nextcloud Tables app (in-process). Import a Tables table into a
 * RegiBase collection, and export a RegiBase collection into a new Tables table.
 *
 * Tables exposes no public OCP API, so its service classes are resolved lazily
 * from the server container and the app is treated as optional (available()).
 */
class TablesBridge {
	/** RegiBase field types that hold attachments (file ids) — cannot go to Tables. */
	private const ATTACH_TYPES = ['image', 'image_crop', 'file'];

	public function available(): bool {
		try {
			return Server::get(IAppManager::class)->isInstalled('tables');
		} catch (\Throwable $e) {
			return false;
		}
	}

	/** @return object */
	private function tableService() { return Server::get(\OCA\Tables\Service\TableService::class); }
	/** @return object */
	private function columnService() { return Server::get(\OCA\Tables\Service\ColumnService::class); }
	/** @return object */
	private function rowService() { return Server::get(\OCA\Tables\Service\RowService::class); }

	/**
	 * Tables the user can access, for the import picker.
	 * @return array<int, array{id:int, title:string, emoji:?string, columns:int}>
	 */
	public function listTables(string $userId): array {
		$out = [];
		foreach ($this->tableService()->findAll($userId) as $t) {
			$id = (int)$t->getId();
			$cols = 0;
			try {
				$cols = count($this->columnService()->findAllByTable($id, $userId));
			} catch (\Throwable $e) { /* keep listing */ }
			$out[] = [
				'id' => $id,
				'title' => (string)$t->getTitle(),
				'emoji' => method_exists($t, 'getEmoji') ? $t->getEmoji() : null,
				'columns' => $cols,
			];
		}
		return $out;
	}

	private static function subtype($col): string {
		return method_exists($col, 'getSubtype') ? (string)$col->getSubtype() : '';
	}

	/** Slug a column title into a stable RegiBase field key. */
	private static function keyFor(string $title, int $colId, array $used): string {
		$k = strtolower(trim($title));
		$k = preg_replace('/[^a-z0-9]+/u', '_', $k) ?? '';
		$k = trim($k, '_');
		if ($k === '' || preg_match('/[^\x00-\x7F]/', $k)) {
			$k = 'col' . $colId;
		}
		$base = substr($k, 0, 180);
		$k = $base;
		$n = 2;
		while (in_array($k, $used, true)) {
			$k = $base . '_' . $n;
			$n++;
		}
		return $k;
	}

	/** Map one Tables column to a RegiBase field definition. */
	private function fieldFor($col, string $key): array {
		$type = (string)$col->getType();
		$sub = self::subtype($col);
		$f = ['key' => $key, 'label' => (string)$col->getTitle(), 'type' => 'text'];
		switch ($type) {
			case 'number':
				$f['type'] = 'number';
				break;
			case 'datetime':
				$f['type'] = ($sub === 'date') ? 'date' : 'text';
				break;
			case 'text':
				if ($sub === 'long' || $sub === 'rich') {
					$f['type'] = 'textarea';
				} elseif ($sub === 'link') {
					$f['type'] = 'url';
				} else {
					$f['type'] = 'text';
				}
				break;
			case 'selection':
				if ($sub === '' || $sub === 'default') {
					$opts = [];
					foreach ($col->getSelectionOptionsArray() as $o) {
						if (isset($o['label'])) {
							$opts[] = (string)$o['label'];
						}
					}
					$f['type'] = 'select';
					$f['options'] = $opts;
				} else {
					$f['type'] = 'text';
				}
				break;
			default:
				$f['type'] = 'text';
		}
		return $f;
	}

	/** Convert a stored Tables cell value to a RegiBase string, resolving selection ids. */
	private function cellToString($col, $value, array $selMap): string {
		if ($value === null || $value === '') {
			return '';
		}
		$type = (string)$col->getType();
		$sub = self::subtype($col);
		if ($type === 'selection' && ($sub === '' || $sub === 'default')) {
			$ids = is_array($value) ? $value : (is_string($value) && str_starts_with($value, '[') ? (json_decode($value, true) ?: [$value]) : [$value]);
			$labels = [];
			foreach ((array)$ids as $id) {
				$labels[] = $selMap[(string)$id] ?? (string)$id;
			}
			return implode(', ', $labels);
		}
		if ($type === 'datetime' && $sub === 'date') {
			return substr((string)$value, 0, 10);
		}
		if (is_array($value)) {
			return implode(', ', array_map(fn ($v) => is_scalar($v) ? (string)$v : json_encode($v), $value));
		}
		return (string)$value;
	}

	/**
	 * Build a RegiBase collection payload (fields + records) from a Tables table.
	 * @return array{name:string, icon:string, color:string, view:string, fields:array, records:array}
	 */
	public function buildImport(string $userId, int $tableId): array {
		$table = $this->tableService()->find($tableId, false, $userId);
		$columns = $this->columnService()->findAllByTable($tableId, $userId);

		$fields = [];
		$byColId = [];       // columnId => field key
		$selMaps = [];       // columnId => [optionId => label]
		$used = [];
		foreach ($columns as $col) {
			$colId = (int)$col->getId();
			$key = self::keyFor((string)$col->getTitle(), $colId, $used);
			$used[] = $key;
			$fields[] = $this->fieldFor($col, $key);
			$byColId[$colId] = $col;
			$map = [];
			if ((string)$col->getType() === 'selection') {
				try {
					foreach ($col->getSelectionOptionsArray() as $o) {
						if (isset($o['id'])) {
							$map[(string)$o['id']] = (string)($o['label'] ?? $o['id']);
						}
					}
				} catch (\Throwable $e) { /* ignore */ }
			}
			$selMaps[$colId] = $map;
		}
		$keyByColId = [];
		foreach ($fields as $i => $f) {
			$keyByColId[(int)$columns[$i]->getId()] = $f['key'];
		}

		$records = [];
		foreach ($this->rowService()->findAllByTable($tableId, $userId) as $row) {
			$data = [];
			foreach (($row->getData() ?? []) as $cell) {
				$colId = (int)($cell['columnId'] ?? 0);
				if (!isset($byColId[$colId])) {
					continue;
				}
				$s = $this->cellToString($byColId[$colId], $cell['value'] ?? null, $selMaps[$colId] ?? []);
				if ($s !== '') {
					$data[$keyByColId[$colId]] = $s;
				}
			}
			$records[] = $data;
		}

		$emoji = method_exists($table, 'getEmoji') ? (string)$table->getEmoji() : '';
		return [
			'name' => (string)$table->getTitle(),
			'icon' => $emoji !== '' ? $emoji : '📊',
			'color' => '#16a34a',
			'view' => 'list',
			'fields' => $fields,
			'records' => $records,
		];
	}

	/**
	 * Export a RegiBase collection (its fields + records) into a NEW Tables table.
	 * Secret and attachment fields are skipped (their stored values are ciphertext
	 * or file ids and would be meaningless in Tables).
	 * @param array $fields  RegiBase field definitions (jsonSerialize form)
	 * @param array $records RegiBase records (each with a 'data' assoc keyed by field key)
	 * @return array{tableId:int, exported:int, skippedFields:int}
	 */
	public function exportCollection(string $userId, string $title, ?string $emoji, ?string $description, array $fields, array $records): array {
		$table = $this->tableService()->create($title, 'custom', $emoji ?: null, (string)($description ?? ''), $userId);
		$tableId = (int)$table->getId();

		$colIdByKey = [];
		$typeByKey = [];
		$skipped = 0;
		foreach ($fields as $f) {
			if (!empty($f['secret']) || in_array((string)($f['type'] ?? 'text'), self::ATTACH_TYPES, true)) {
				$skipped++;
				continue;
			}
			$key = (string)$f['key'];
			$dto = $this->columnDtoFor($f);
			$col = $this->columnService()->create($userId, $tableId, null, $dto);
			$colIdByKey[$key] = (int)$col->getId();
			$typeByKey[$key] = (string)($f['type'] ?? 'text');
		}

		$exported = 0;
		foreach ($records as $rec) {
			$data = [];
			$rowData = is_array($rec['data'] ?? null) ? $rec['data'] : (is_array($rec) ? $rec : []);
			foreach ($colIdByKey as $key => $colId) {
				if (!array_key_exists($key, $rowData)) {
					continue;
				}
				$val = $this->exportValue($typeByKey[$key] ?? 'text', $rowData[$key]);
				if ($val === null || $val === '') {
					continue;
				}
				$data[] = ['columnId' => $colId, 'value' => $val];
			}
			$this->rowService()->create($tableId, null, $data);
			$exported++;
		}

		return ['tableId' => $tableId, 'exported' => $exported, 'skippedFields' => $skipped];
	}

	private function columnDtoFor(array $f) {
		$title = (string)($f['label'] ?? $f['key'] ?? 'Column');
		$type = (string)($f['type'] ?? 'text');
		$dtoClass = \OCA\Tables\Dto\Column::class;
		switch ($type) {
			case 'number':
				return new $dtoClass(title: $title, type: 'number', numberDecimals: 0);
			case 'textarea':
				return new $dtoClass(title: $title, type: 'text', subtype: 'long');
			case 'date':
			case 'month':
				return new $dtoClass(title: $title, type: 'datetime', subtype: 'date');
			default:
				return new $dtoClass(title: $title, type: 'text', subtype: 'line');
		}
	}

	private function exportValue(string $type, $value) {
		if ($value === null) {
			return '';
		}
		if (is_array($value)) {
			$value = implode(', ', array_map(fn ($v) => is_scalar($v) ? (string)$v : json_encode($v), $value));
		}
		if ($type === 'number') {
			return is_numeric($value) ? (float)$value : (string)$value;
		}
		if ($type === 'date' || $type === 'month') {
			return substr((string)$value, 0, 10);
		}
		return (string)$value;
	}
}
