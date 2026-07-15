<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCA\RegiBase\Db\CollectionMapper;
use OCA\RegiBase\Db\FieldEntity;
use OCA\RegiBase\Db\FieldMapper;
use OCA\RegiBase\Db\TemplateEntity;
use OCA\RegiBase\Db\TemplateMapper;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\IL10N;

/**
 * User-defined collection templates plus per-user overrides of the built-in
 * templates. The New-collection picker shows the merged result: each built-in
 * (replaced by the user's override when present) followed by custom templates.
 */
class TemplateService {
	public function __construct(
		private TemplateMapper $templates,
		private CollectionMapper $collections,
		private FieldMapper $fields,
		private IL10N $l,
	) {
	}

	private function now(): string {
		return gmdate('Y-m-d\TH:i:s\Z');
	}

	/** Merged list for the picker: built-ins (with overrides applied) + custom templates. */
	public function merged(IL10N $l, string $userId): array {
		$rows = $this->templates->findAllForUser($userId);
		$overrides = [];   // builtin_key => entity
		$customs = [];     // entities with builtin_key === null
		foreach ($rows as $r) {
			$bk = $r->getBuiltinKey();
			if ($bk !== null && $bk !== '') {
				$overrides[$bk] = $r;
			} else {
				$customs[] = $r;
			}
		}

		$out = [];
		foreach (Templates::all($l) as $bt) {
			$ov = $overrides[$bt['key']] ?? null;
			if ($ov !== null) {
				$out[] = [
					'key' => $bt['key'],
					'name' => $ov->getName(),
					'icon' => $ov->getIcon(),
					'color' => $ov->getColor(),
					'description' => $ov->getDescription() ?? '',
					'fields' => $ov->fieldsArray(),
					'builtin' => true,
					'custom' => false,
					'overridden' => true,
					'row_id' => (int)$ov->getId(),
				];
			} else {
				$out[] = [
					'key' => $bt['key'],
					'name' => $bt['name'],
					'icon' => $bt['icon'],
					'color' => $bt['color'],
					'description' => $bt['description'] ?? '',
					'fields' => $bt['fields'],
					'builtin' => true,
					'custom' => false,
					'overridden' => false,
					'row_id' => null,
				];
			}
		}
		foreach ($customs as $c) {
			$out[] = [
				'key' => $c->getTplKey(),
				'name' => $c->getName(),
				'icon' => $c->getIcon(),
				'color' => $c->getColor(),
				'description' => $c->getDescription() ?? '',
				'fields' => $c->fieldsArray(),
				'builtin' => false,
				'custom' => true,
				'overridden' => false,
				'row_id' => (int)$c->getId(),
			];
		}
		return $out;
	}

	/** Normalise incoming field defs to the stored shape (drops empty labels). */
	private function cleanFields(array $fields): array {
		$out = [];
		foreach ($fields as $f) {
			if (!is_array($f)) {
				continue;
			}
			$label = trim((string)($f['label'] ?? ''));
			if ($label === '') {
				continue;
			}
			$row = [
				'key' => (string)($f['key'] ?? ''),
				'label' => $label,
				'type' => (string)($f['type'] ?? 'text'),
				'required' => !empty($f['required']),
				'secret' => !empty($f['secret']),
				'is_title' => !empty($f['is_title']),
			];
			if (isset($f['options']) && $f['options'] !== '' && $f['options'] !== null && $f['options'] !== []) {
				$row['options'] = $f['options'];
			}
			if (isset($f['placeholder']) && $f['placeholder'] !== '' && $f['placeholder'] !== null) {
				$row['placeholder'] = (string)$f['placeholder'];
			}
			$out[] = $row;
		}
		return $out;
	}

	private function uniqueKey(string $userId, string $base): string {
		$slug = strtolower(preg_replace('/[^a-z0-9]+/i', '_', $base) ?? '');
		$slug = trim($slug, '_');
		if ($slug === '') {
			$slug = 'tpl';
		}
		$key = 'u_' . $slug;
		$existing = array_map(fn (TemplateEntity $t) => $t->getTplKey(), $this->templates->findAllForUser($userId));
		if (!in_array($key, $existing, true)) {
			return $key;
		}
		$i = 2;
		while (in_array($key . '_' . $i, $existing, true)) {
			$i++;
		}
		return $key . '_' . $i;
	}

	/** Create a new custom template from explicit meta + fields. */
	public function create(string $userId, array $in): array {
		$name = trim((string)($in['name'] ?? '')) ?: $this->l->t('My template');
		$e = new TemplateEntity();
		$e->setUserId($userId);
		$e->setTplKey($this->uniqueKey($userId, $name));
		$e->setBuiltinKey(null);
		$e->setName($name);
		$e->setIcon((string)($in['icon'] ?? '📁'));
		$e->setColor((string)($in['color'] ?? '#3b82f6'));
		$e->setDescription((string)($in['description'] ?? ''));
		$e->setFields(json_encode($this->cleanFields($in['fields'] ?? []), JSON_UNESCAPED_UNICODE));
		$e->setSort($this->templates->maxSort($userId) + 1);
		$e->setCreatedAt($this->now());
		$e->setUpdatedAt($this->now());
		$e = $this->templates->insert($e);
		return $e->jsonSerialize();
	}

	/** Create a custom template from an existing collection's fields. */
	public function fromCollection(string $userId, int $collectionId, ?string $name): array {
		$c = $this->collections->findForUser($collectionId, $userId); // ownership check
		$fields = array_map(fn (FieldEntity $f) => $f->jsonSerialize(), $this->fields->findForCollection($collectionId));
		return $this->create($userId, [
			'name' => ($name !== null && trim($name) !== '') ? $name : $c->getName(),
			'icon' => $c->getIcon(),
			'color' => $c->getColor(),
			'description' => $c->getDescription() ?? '',
			'fields' => $fields,
		]);
	}

	/** Update an existing template row (custom template or built-in override). */
	public function update(string $userId, int $id, array $patch): array {
		$e = $this->templates->findForUser($id, $userId);
		if (isset($patch['name'])) {
			$e->setName((string)$patch['name']);
		}
		if (isset($patch['icon'])) {
			$e->setIcon((string)$patch['icon']);
		}
		if (isset($patch['color'])) {
			$e->setColor((string)$patch['color']);
		}
		if (isset($patch['description'])) {
			$e->setDescription((string)$patch['description']);
		}
		if (isset($patch['fields']) && is_array($patch['fields'])) {
			$e->setFields(json_encode($this->cleanFields($patch['fields']), JSON_UNESCAPED_UNICODE));
		}
		$e->setUpdatedAt($this->now());
		$this->templates->update($e);
		return $e->jsonSerialize();
	}

	/** Create or update the user's override of a built-in template. */
	public function editBuiltin(string $userId, string $builtinKey, array $in, IL10N $l): array {
		$base = Templates::byKey($l, $builtinKey);
		if ($base === null) {
			throw new \RuntimeException('unknown built-in template');
		}
		$e = $this->templates->findOverride($userId, $builtinKey);
		if ($e === null) {
			$e = new TemplateEntity();
			$e->setUserId($userId);
			$e->setTplKey($builtinKey);
			$e->setBuiltinKey($builtinKey);
			$e->setSort($this->templates->maxSort($userId) + 1);
			$e->setCreatedAt($this->now());
			$e->setName($base['name']);
			$e->setIcon($base['icon']);
			$e->setColor($base['color']);
			$e->setDescription($base['description'] ?? '');
			$e->setFields(json_encode($base['fields'], JSON_UNESCAPED_UNICODE));
			$e->setUpdatedAt($this->now());
			$e = $this->templates->insert($e);
		}
		return $this->update($userId, (int)$e->getId(), $in);
	}

	/** Delete a custom template, or reset a built-in override, by row id. */
	public function delete(string $userId, int $id): void {
		$e = $this->templates->findForUser($id, $userId);
		$this->templates->delete($e);
	}

	/** Reset a built-in template to its shipped default (removes the override). */
	public function resetBuiltin(string $userId, string $builtinKey): void {
		$e = $this->templates->findOverride($userId, $builtinKey);
		if ($e !== null) {
			$this->templates->delete($e);
		}
	}
}
