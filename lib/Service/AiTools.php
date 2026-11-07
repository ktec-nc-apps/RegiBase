<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCA\RegiBase\AppInfo\Application;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\ISession;
use OCP\L10N\IFactory;

/**
 * What the assistant can do inside RegiBase by itself (the owner, 2026-11-07: "RegiBase の中は
 * 自由に AI が操作できるようにしろ。当然、シークレットに関しては、シークレットコードを打ち込んだ後だけだ。").
 *
 * The tools run with the rights of the person asking, through RegiBaseService, so a share's
 * level, an edit lock and the undo history hold as they do on the page: every change the
 * assistant makes can be taken back with "↶ Undo".
 *
 * Secrets:
 * - A secret collection, and the collections of a secret category, exist for the assistant only
 *   after the person gave their 6-digit key in this session. AI-Hub answers in a request of its
 *   own, without the person's session, so what was open is noted when the question is asked
 *   (noteOpen()) and taken up by the tools; "Hide secret collections" clears it (forgetOpen()).
 * - A secret field's value is never read or written by the assistant, open or not: it is left
 *   out of everything a tool returns, a search never looks at it, and a write to it is refused.
 *   (With a master key it is encrypted in the browser and the server could not read it anyway.)
 */
class AiTools {
	/** How long what was open is remembered for the tools: as long as a question can run. */
	private const OPEN_TTL = 3600;
	/** The most characters a tool hands back. */
	private const OUT_MAX = 60000;
	private const CAT_OPEN = 'regibase_cat_open';
	private const ATTACH = ['image', 'image_crop', 'file'];

	public function __construct(
		private RegiBaseService $service,
		private IConfig $config,
		private ISession $session,
		private ICacheFactory $cacheFactory,
		private IFactory $l10nFactory,
	) {
	}

	/** In the asker's language: AI-Hub runs the tools in a request of its own, without theirs. */
	private function l(string $uid = ''): \OCP\IL10N {
		$lang = $uid !== '' ? $this->config->getUserValue($uid, 'core', 'lang', '') : '';
		return $lang !== '' ? $this->l10nFactory->get(Application::APP_ID, $lang) : $this->l10nFactory->get(Application::APP_ID);
	}

	/** What a change did, for the list shown under the answer: "label — n: names". */
	private static function report(string $label, array $names, int $n = -1): string {
		$n = $n < 0 ? count($names) : $n;
		$names = array_values(array_filter(array_map(fn ($x) => trim((string)$x), $names), fn ($x) => $x !== ''));
		$shown = array_slice($names, 0, 20);
		return $label . ' — ' . $n . ($shown !== [] ? ': ' . implode(', ', $shown) . (count($names) > 20 ? ', …' : '') : '');
	}

	// ---- what was open when the question was asked ----

	private function cache(): ?\OCP\ICache {
		return $this->cacheFactory->isAvailable() ? $this->cacheFactory->createDistributed(Application::APP_ID . '_ai_open') : null;
	}

	/** Called in the person's own request, as the question is asked. */
	public function noteOpen(string $uid): void {
		$ids = [];
		foreach ($this->service->ownSecretCollectionIds($uid) as $id) {
			if ($this->session->get(RegiBaseService::secretOpenKey($id)) === true) {
				$ids[] = $id;
			}
		}
		$cats = $this->session->get(self::CAT_OPEN);
		$state = ['ids' => $ids, 'cats' => is_array($cats) ? array_values(array_filter($cats, 'is_string')) : []];
		$cache = $this->cache();
		if ($cache !== null) {
			$cache->set('open_' . $uid, json_encode($state), self::OPEN_TTL);
		} else {
			$this->config->setUserValue($uid, Application::APP_ID, 'ai_open', json_encode($state + ['until' => time() + self::OPEN_TTL]));
		}
	}

	/** "Hide secret collections": the assistant loses them too. */
	public function forgetOpen(string $uid): void {
		$this->cache()?->remove('open_' . $uid);
		$this->config->deleteUserValue($uid, Application::APP_ID, 'ai_open');
	}

	/** In the request AI-Hub answers in: open in this session what the person had open. */
	private function takeUpOpen(string $uid): void {
		$cache = $this->cache();
		$raw = $cache !== null ? $cache->get('open_' . $uid) : $this->config->getUserValue($uid, Application::APP_ID, 'ai_open', '');
		$state = is_string($raw) ? json_decode($raw, true) : null;
		if (!is_array($state) || (isset($state['until']) && (int)$state['until'] < time())) {
			return;
		}
		foreach ((array)($state['ids'] ?? []) as $id) {
			$this->session->set(RegiBaseService::secretOpenKey((int)$id), true);
		}
		$this->session->set(self::CAT_OPEN, array_values(array_filter((array)($state['cats'] ?? []), 'is_string')));
	}

	// ---- the tools ----

	/**
	 * The tools, as AI-Hub takes them. Which of them may run is the administrator's setting,
	 * looked up when one runs.
	 *
	 * @param callable(): list<string> $allowed What the administrator allows (AiService::SOURCES).
	 */
	public function tools(callable $allowed): array {
		$wrap = function (string $need, callable $fn) use ($allowed): callable {
			return function (string $uid, array $args) use ($need, $fn, $allowed) {
				if (!in_array($need, $allowed(), true)) {
					return ['error' => $need === 'write'
						? 'The administrator has not allowed the assistant to change anything in RegiBase.'
						: 'The administrator has not allowed the assistant to read this.'];
				}
				$this->takeUpOpen($uid);
				try {
					$out = $fn($uid, $args);
				} catch (LockedException $e) {
					$out = ['error' => 'That collection is locked (an edit lock or a share password). Unlock it on the page first.'];
				} catch (ForbiddenException $e) {
					$out = ['error' => 'The person asking does not have the right to do that (a shared collection\'s level, or not the owner).'];
				} catch (FieldRuleException $e) {
					$out = ['error' => 'A value does not fit the field\'s rules: ' . $e->getMessage()];
				} catch (\OCP\AppFramework\Db\DoesNotExistException $e) {
					$out = ['error' => 'Not found (or it is secret and not opened with its key in this session).'];
				} catch (\InvalidArgumentException $e) {
					$out = ['error' => $e->getMessage()];
				}
				$json = json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
				return mb_strlen($json) > self::OUT_MAX ? mb_substr($json, 0, self::OUT_MAX) . ' …(cut: ask for fewer, or use offset)' : $json;
			};
		};
		$ids = ['type' => 'array', 'items' => ['type' => 'integer']];
		$l = $this->l();
		return [
			'list_collections' => [
				'kind' => 'read',
				'label' => $l->t('Look at the collections'),
				'description' => 'Every collection the person can see now, with its id, name, icon, category ("" = uncategorized), number of records, whether it is theirs or shared to them (and at what level), and whether it is secret (shown only when opened with its key in this session).',
				'input' => ['type' => 'object', 'properties' => new \stdClass()],
				'run' => $wrap('collections', fn ($uid) => $this->listCollections($uid)),
			],
			'get_collection' => [
				'kind' => 'read',
				'label' => $l->t('Look at a collection'),
				'description' => 'One collection\'s settings and field definitions: key, label, type, choices, required, secret, title field.',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer']], 'required' => ['id']],
				'run' => $wrap('collections', fn ($uid, $a) => $this->getCollection($uid, (int)$a['id'])),
			],
			'find_records' => [
				'kind' => 'read',
				'label' => $l->t('Find records'),
				'description' => 'Records of one or more collections (all the person can see when collection_ids is left out), each as {id, collection, data: {field key: value}}. Secret fields are never included. query: words that must all appear in the non-secret values (case and width ignored). Up to limit (default 200, at most 500) from offset.',
				'input' => ['type' => 'object', 'properties' => [
					'collection_ids' => $ids, 'category' => ['type' => 'string'], 'query' => ['type' => 'string'],
					'limit' => ['type' => 'integer'], 'offset' => ['type' => 'integer'],
				]],
				'run' => $wrap('records', fn ($uid, $a) => $this->findRecords($uid, $a)),
			],
			'find_duplicates' => [
				'kind' => 'read',
				'label' => $l->t('Find duplicates'),
				'description' => 'Groups of records that are the same in the given fields (matched by field key or label, case, width and spaces ignored), within and across the collections given (all the person can see when left out; or one category by name, "" = uncategorized). fields left out: the title field. Returns only groups of two or more, with each record\'s values; secret_fields_filled names the secret fields that hold a value (never the value) -- keep that record when removing duplicates.',
				'input' => ['type' => 'object', 'properties' => [
					'collection_ids' => $ids, 'category' => ['type' => 'string'],
					'fields' => ['type' => 'array', 'items' => ['type' => 'string']],
				]],
				'run' => $wrap('records', fn ($uid, $a) => $this->findDuplicates($uid, $a)),
			],
			'create_records' => [
				'kind' => 'create',
				'label' => $l->t('Add records'),
				'description' => 'Add records to a collection: records is a list of {field key: value}. Choices are given as in the field\'s choices (checkbox: a list). Up to 200 at once.',
				'input' => ['type' => 'object', 'properties' => ['collection_id' => ['type' => 'integer'],
					'records' => ['type' => 'array', 'items' => ['type' => 'object']]], 'required' => ['collection_id', 'records']],
				'run' => $wrap('write', fn ($uid, $a) => $this->createRecords($uid, (int)$a['collection_id'], (array)$a['records'])),
			],
			'update_records' => [
				'kind' => 'update',
				'label' => $l->t('Change records'),
				'description' => 'Change records: updates is a list of {id, data: {field key: new value}}; only the fields given change ("" empties one). Up to 200 at once.',
				'input' => ['type' => 'object', 'properties' => ['updates' => ['type' => 'array', 'items' => ['type' => 'object',
					'properties' => ['id' => ['type' => 'integer'], 'data' => ['type' => 'object']], 'required' => ['id', 'data']]]], 'required' => ['updates']],
				'run' => $wrap('write', fn ($uid, $a) => $this->updateRecords($uid, (array)$a['updates'])),
			],
			'delete_records' => [
				'kind' => 'delete',
				'label' => $l->t('Delete records'),
				'description' => 'Delete records by id (they can be brought back with "↶ Undo").',
				'input' => ['type' => 'object', 'properties' => ['ids' => $ids], 'required' => ['ids']],
				'run' => $wrap('write', fn ($uid, $a) => $this->deleteRecords($uid, array_map('intval', (array)$a['ids']))),
			],
			'create_collection' => [
				'kind' => 'create',
				'label' => $l->t('Make a collection'),
				'description' => 'Make a collection: name, icon (an emoji), description, category, and fields: a list of {label, type, choices (for select/radio/checkbox), required, is_title}. Types: text, textarea, password, number, date, month, datetime, datetime_sec, email, tel, url, address, select, radio, checkbox.',
				'input' => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'icon' => ['type' => 'string'],
					'description' => ['type' => 'string'], 'category' => ['type' => 'string'],
					'fields' => ['type' => 'array', 'items' => ['type' => 'object']]], 'required' => ['name', 'fields']],
				'run' => $wrap('write', fn ($uid, $a) => $this->createCollection($uid, $a)),
			],
			'update_collection' => [
				'kind' => 'update',
				'label' => $l->t('Change a collection'),
				'description' => 'Change a collection of the person\'s own: name, icon, description, category ("" = uncategorized). Only what is given changes.',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer'], 'name' => ['type' => 'string'],
					'icon' => ['type' => 'string'], 'description' => ['type' => 'string'], 'category' => ['type' => 'string']], 'required' => ['id']],
				'run' => $wrap('write', fn ($uid, $a) => $this->updateCollection($uid, $a)),
			],
			'set_fields' => [
				'kind' => 'update',
				'label' => $l->t('Change the fields'),
				'description' => 'Replace a collection\'s fields with this list, in this order: each {key (keep an existing key to keep its values; leave out for a new field), label, type, choices, required, is_title}. A field left out is removed with its values. A secret field must be kept as it is (give its key, label and type unchanged).',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer'],
					'fields' => ['type' => 'array', 'items' => ['type' => 'object']]], 'required' => ['id', 'fields']],
				'run' => $wrap('write', fn ($uid, $a) => $this->setFields($uid, (int)$a['id'], (array)$a['fields'])),
			],
			'delete_collection' => [
				'kind' => 'delete',
				'label' => $l->t('Delete a collection'),
				'description' => 'Delete a collection of the person\'s own, with its records (it can be brought back with "↶ Undo"; attachment files go to the trash bin).',
				'input' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer']], 'required' => ['id']],
				'run' => $wrap('write', fn ($uid, $a) => $this->deleteCollection($uid, (int)$a['id'])),
			],
		];
	}

	// ---- reading ----

	/** id => category name, the person's own filing. */
	private function categoryMap(string $uid): array {
		$raw = json_decode($this->config->getUserValue($uid, Application::APP_ID, 'coll_categories', '{}'), true);
		$map = [];
		foreach (is_array($raw) ? $raw : [] as $id => $name) {
			if (is_numeric($id) && is_string($name) && $name !== '') {
				$map[(int)$id] = $name;
			}
		}
		return $map;
	}

	/** Secret categories not opened: name => true. */
	private function hiddenCategories(string $uid): array {
		$meta = json_decode($this->config->getUserValue($uid, Application::APP_ID, 'coll_category_meta', '{}'), true);
		$open = $this->session->get(self::CAT_OPEN);
		$open = is_array($open) ? $open : [];
		$out = [];
		foreach (is_array($meta) ? $meta : [] as $name => $m) {
			if (is_array($m) && !empty($m['secret']) && !in_array((string)$name, $open, true)) {
				$out[(string)$name] = true;
			}
		}
		return $out;
	}

	/** What the person sees in the sidebar now: id => collection json (with 'category'). */
	private function visible(string $uid): array {
		$list = $this->service->listCollections($uid);
		foreach ($this->service->ownSecretCollectionIds($uid) as $id) {
			if ($this->session->get(RegiBaseService::secretOpenKey($id)) === true) {
				try {
					$j = $this->service->getCollection($uid, $id);
					$j['record_count'] = count($this->service->listRecords($uid, $id, null, null));
					$list[] = $j;
				} catch (\Throwable $e) {
				}
			}
		}
		$map = $this->categoryMap($uid);
		$hidden = $this->hiddenCategories($uid);
		$out = [];
		foreach ($list as $j) {
			$id = (int)$j['id'];
			$cat = $map[$id] ?? '';
			if (isset($hidden[$cat])) {
				continue;
			}
			$j['category'] = $cat;
			$out[$id] = $j;
		}
		return $out;
	}

	private function mustSee(string $uid, int $id): array {
		$v = $this->visible($uid);
		if (!isset($v[$id])) {
			throw new \OCP\AppFramework\Db\DoesNotExistException('not visible');
		}
		return $v[$id];
	}

	private function listCollections(string $uid): array {
		$out = [];
		foreach ($this->visible($uid) as $id => $j) {
			$out[] = [
				'id' => $id, 'name' => (string)($j['name'] ?? ''), 'icon' => (string)($j['icon'] ?? ''),
				'category' => $j['category'], 'records' => (int)($j['record_count'] ?? 0),
				'owner' => !empty($j['is_owner']) ? 'own' : 'shared to them (' . (string)($j['perm'] ?? 'view') . ')',
				'secret' => !empty($j['secret']), 'locked' => !empty($j['locked']),
			];
		}
		return ['collections' => $out];
	}

	private static function fieldOut(array $f): array {
		$o = ['key' => (string)$f['key'], 'label' => (string)$f['label'], 'type' => (string)$f['type']];
		if (is_array($f['options'] ?? null) && array_is_list($f['options'])) {
			$o['choices'] = $f['options'];
		}
		foreach (['required', 'secret', 'is_title'] as $k) {
			if (!empty($f[$k])) {
				$o[$k] = true;
			}
		}
		return $o;
	}

	private function getCollection(string $uid, int $id): array {
		$v = $this->mustSee($uid, $id);
		$c = $this->service->getCollection($uid, $id);
		return [
			'id' => $id, 'name' => $c['name'] ?? '', 'icon' => $c['icon'] ?? '', 'description' => $c['description'] ?? '',
			'category' => $v['category'], 'locked' => !empty($c['locked']),
			'fields' => array_map([self::class, 'fieldOut'], (array)($c['fields'] ?? [])),
		];
	}

	/** The fields a tool may show or write: not secret, not attachments. key => field */
	private function openFields(string $uid, int $id): array {
		$out = [];
		foreach ((array)($this->service->getCollection($uid, $id)['fields'] ?? []) as $f) {
			if (empty($f['secret']) && !in_array($f['type'], self::ATTACH, true)) {
				$out[(string)$f['key']] = $f;
			}
		}
		return $out;
	}

	/** The collections a reading tool looks at. */
	private function targets(string $uid, array $a): array {
		$visible = $this->visible($uid);
		$ids = is_array($a['collection_ids'] ?? null) && $a['collection_ids'] !== [] ? array_map('intval', $a['collection_ids']) : array_keys($visible);
		$cat = is_string($a['category'] ?? null) ? trim($a['category']) : null;
		$out = [];
		foreach ($ids as $id) {
			if (!isset($visible[$id])) {
				throw new \OCP\AppFramework\Db\DoesNotExistException('not visible');
			}
			if ($cat !== null && $visible[$id]['category'] !== $cat) {
				continue;
			}
			$out[] = $id;
		}
		return $out;
	}

	private static function norm(string $s): string {
		$s = class_exists(\Normalizer::class) ? (\Normalizer::normalize($s, \Normalizer::FORM_KC) ?: $s) : $s;
		return mb_strtolower(trim((string)preg_replace('/\s+/u', ' ', $s)));
	}

	private static function valueText($v): string {
		return is_array($v) ? implode(', ', array_map('strval', array_filter($v, 'is_scalar'))) : (is_scalar($v) ? (string)$v : '');
	}

	/** Every non-secret record of the targets: list of [collection id, record id, data]. */
	private function rows(string $uid, array $ids): array {
		$rows = [];
		$names = array_map(fn ($j) => (string)($j['name'] ?? ''), $this->visible($uid));
		foreach ($ids as $cid) {
			$fields = $this->openFields($uid, $cid);
			$secret = [];
			foreach ((array)($this->service->getCollection($uid, $cid)['fields'] ?? []) as $f) {
				if (!empty($f['secret'])) {
					$secret[(string)$f['key']] = (string)$f['label'];
				}
			}
			foreach ($this->service->listRecords($uid, $cid, null, null) as $r) {
				$data = [];
				$filled = [];
				foreach ((array)($r['data'] ?? []) as $k => $v) {
					if ($v === '' || $v === null || $v === []) {
						continue;
					}
					if (isset($fields[$k])) {
						$data[$k] = is_string($v) ? mb_substr($v, 0, 2000) : $v;
					} elseif (isset($secret[$k])) {
						$filled[] = $secret[$k]; // only that it has a value, never the value
					}
				}
				$row = ['id' => (int)$r['id'], 'collection' => $cid, 'collection_name' => $names[$cid] ?? '', 'data' => $data];
				if ($filled !== []) {
					$row['secret_fields_filled'] = $filled;
				}
				$rows[] = $row;
			}
		}
		return $rows;
	}

	private function findRecords(string $uid, array $a): array {
		$ids = $this->targets($uid, $a);
		$rows = $this->rows($uid, $ids);
		$words = array_filter(explode(' ', self::norm((string)($a['query'] ?? ''))), fn ($w) => $w !== '');
		if ($words !== []) {
			$rows = array_values(array_filter($rows, function ($r) use ($words) {
				$text = self::norm(implode(' ', array_map([self::class, 'valueText'], $r['data'])));
				foreach ($words as $w) {
					if (!str_contains($text, $w)) {
						return false;
					}
				}
				return true;
			}));
		}
		$limit = max(1, min(500, (int)($a['limit'] ?? 200)));
		$offset = max(0, (int)($a['offset'] ?? 0));
		return ['total' => count($rows), 'offset' => $offset, 'records' => array_slice($rows, $offset, $limit)];
	}

	private function findDuplicates(string $uid, array $a): array {
		$ids = $this->targets($uid, $a);
		$want = array_values(array_filter(array_map(fn ($s) => self::norm((string)$s), (array)($a['fields'] ?? [])), fn ($s) => $s !== ''));
		$groups = [];
		$used = [];
		foreach ($ids as $cid) {
			$fields = $this->openFields($uid, $cid);
			$keys = [];
			if ($want === []) {
				foreach ($fields as $k => $f) {
					if (!empty($f['is_title'])) {
						$keys[] = $k;
					}
				}
				if ($keys === [] && $fields !== []) {
					$keys[] = (string)array_key_first($fields);
				}
			} else {
				foreach ($want as $w) {
					foreach ($fields as $k => $f) {
						if (self::norm($k) === $w || self::norm((string)$f['label']) === $w) {
							$keys[] = $k;
							break;
						}
					}
				}
				if (count($keys) !== count($want)) {
					continue; // this collection does not have every field asked for
				}
			}
			if ($keys === []) {
				continue;
			}
			$used[$cid] = array_map(fn ($k) => (string)$fields[$k]['label'] . ' (' . $k . ')', $keys);
			foreach ($this->rows($uid, [$cid]) as $r) {
				$parts = array_map(fn ($k) => self::norm(self::valueText($r['data'][$k] ?? '')), $keys);
				if (implode('', $parts) === '') {
					continue;
				}
				$groups[implode("\x1f", $parts)][] = $r;
			}
		}
		$out = array_values(array_filter($groups, fn ($g) => count($g) > 1));
		return ['fields_used' => $used, 'groups' => count($out), 'duplicates' => $out];
	}

	// ---- changing ----

	/** A value for a field the tool may not write is refused, by name. */
	private function checkWrite(string $uid, int $cid, array $data): void {
		$all = [];
		foreach ((array)($this->service->getCollection($uid, $cid)['fields'] ?? []) as $f) {
			$all[(string)$f['key']] = $f;
		}
		foreach (array_keys($data) as $k) {
			$f = $all[$k] ?? null;
			if ($f === null) {
				throw new \InvalidArgumentException('The collection has no field with the key "' . $k . '". Use get_collection for the keys.');
			}
			if (!empty($f['secret'])) {
				throw new \InvalidArgumentException('"' . $f['label'] . '" is a secret field: the assistant never writes a secret value. The person types it on the page.');
			}
			if (in_array($f['type'], self::ATTACH, true)) {
				throw new \InvalidArgumentException('"' . $f['label'] . '" is an attachment field: files are added on the page.');
			}
		}
	}

	private function createRecords(string $uid, int $cid, array $records): array {
		$this->mustSee($uid, $cid);
		if (count($records) > 200) {
			throw new \InvalidArgumentException('At most 200 records at once.');
		}
		$made = [];
		foreach ($records as $data) {
			$data = is_array($data) ? $data : [];
			$this->checkWrite($uid, $cid, $data);
			$made[] = (int)$this->service->createRecord($uid, $cid, $data)['id'];
		}
		$titles = [];
		foreach ($made as $rid) {
			try {
				$titles[] = (string)($this->service->getRecord($uid, $rid)['title'] ?? '');
			} catch (\Throwable $e) {
			}
		}
		return ['created' => count($made), 'ids' => $made, '_report' => self::report($this->l($uid)->t('Add records'), $titles, count($made))];
	}

	private function updateRecords(string $uid, array $updates): array {
		if (count($updates) > 200) {
			throw new \InvalidArgumentException('At most 200 records at once.');
		}
		$done = [];
		$doneNames = [];
		$failed = [];
		foreach ($updates as $u) {
			$id = (int)($u['id'] ?? 0);
			$patch = is_array($u['data'] ?? null) ? $u['data'] : [];
			try {
				$r = $this->service->getRecord($uid, $id);
				$cid = (int)$r['collection_id'];
				$this->mustSee($uid, $cid);
				$this->checkWrite($uid, $cid, $patch);
				$saved = $this->service->updateRecord($uid, $id, array_merge((array)($r['data'] ?? []), $patch));
				$done[] = $id;
				$doneNames[] = (string)($saved['title'] ?? $r['title'] ?? '');
			} catch (\Throwable $e) {
				$failed[] = ['id' => $id, 'why' => $e instanceof \InvalidArgumentException || $e instanceof FieldRuleException ? $e->getMessage() : (new \ReflectionClass($e))->getShortName()];
			}
		}
		return ['updated' => count($done), 'ids' => $done, 'failed' => $failed,
			'_report' => self::report($this->l($uid)->t('Change records'), $doneNames) . ($failed !== [] ? ' / ' . $this->l($uid)->t('Failed') . ' — ' . count($failed) : '')];
	}

	private function deleteRecords(string $uid, array $ids): array {
		$ok = [];
		$okNames = [];
		foreach ($ids as $id) {
			try {
				$r = $this->service->getRecord($uid, $id);
				$this->mustSee($uid, (int)$r['collection_id']);
				$ok[] = $id;
				$okNames[$id] = (string)($r['title'] ?? '');
			} catch (\Throwable $e) {
			}
		}
		$n = $ok === [] ? 0 : $this->service->deleteRecords($uid, $ok);
		$not = array_values(array_diff($ids, $ok));
		return ['deleted' => $n, 'not_deleted' => $not,
			'_report' => self::report($this->l($uid)->t('Delete records'), array_values($okNames), $n) . ($not !== [] ? ' / ' . $this->l($uid)->t('Failed') . ' — ' . count($not) : '')];
	}

	private static function fieldIn(array $f, int $i): array {
		$type = (string)($f['type'] ?? 'text');
		$o = [
			'key' => trim((string)($f['key'] ?? '')) !== '' ? (string)$f['key'] : 'f_' . bin2hex(random_bytes(3)) . '_' . $i,
			'label' => (string)($f['label'] ?? ''),
			'type' => $type,
			'required' => !empty($f['required']),
			'is_title' => !empty($f['is_title']),
		];
		$choices = $f['choices'] ?? ($f['options'] ?? null);
		if (in_array($type, ['select', 'radio', 'checkbox'], true) && is_array($choices)) {
			$o['options'] = array_values(array_map('strval', $choices));
		}
		return $o;
	}

	private function setCategory(string $uid, int $id, string $cat): void {
		$cat = mb_substr(trim((string)preg_replace('/\s+/u', ' ', $cat)), 0, 60);
		$map = $this->categoryMap($uid);
		if ($cat === '') {
			unset($map[$id]);
		} else {
			$map[$id] = $cat;
			$order = json_decode($this->config->getUserValue($uid, Application::APP_ID, 'coll_category_order', '[]'), true);
			$order = is_array($order) ? $order : [];
			if (!in_array($cat, $order, true)) {
				$order[] = $cat;
				$this->config->setUserValue($uid, Application::APP_ID, 'coll_category_order', json_encode($order, JSON_UNESCAPED_UNICODE));
			}
		}
		$this->config->setUserValue($uid, Application::APP_ID, 'coll_categories', json_encode((object)array_map('strval', $map), JSON_UNESCAPED_UNICODE));
	}

	private function createCollection(string $uid, array $a): array {
		$fields = [];
		foreach (array_values((array)($a['fields'] ?? [])) as $i => $f) {
			if (is_array($f)) {
				$fields[] = self::fieldIn($f, $i);
			}
		}
		$c = $this->service->createCollection($uid, [
			'name' => (string)$a['name'], 'icon' => (string)($a['icon'] ?? '📁'),
			'description' => (string)($a['description'] ?? ''), 'fields' => $fields, 'folder_choice' => 'suffix',
		]);
		if (is_string($a['category'] ?? null) && trim($a['category']) !== '') {
			$this->setCategory($uid, (int)$c['id'], $a['category']);
		}
		return ['created' => (int)$c['id'], 'name' => $c['name'], '_report' => self::report($this->l($uid)->t('Make a collection'), [(string)$c['name'] . (is_string($a['category'] ?? null) && trim($a['category']) !== '' ? ' (' . trim($a['category']) . ')' : '')])];
	}

	private function updateCollection(string $uid, array $a): array {
		$id = (int)$a['id'];
		$this->mustSee($uid, $id);
		$patch = array_intersect_key($a, array_flip(['name', 'icon', 'description']));
		if ($patch !== []) {
			$this->service->updateCollection($uid, $id, array_map('strval', $patch));
		}
		if (is_string($a['category'] ?? null)) {
			$this->service->getCollection($uid, $id); // still there and visible
			$this->setCategory($uid, $id, $a['category']);
		}
		$name = (string)($this->service->getCollection($uid, $id)['name'] ?? '');
		return ['updated' => $id, '_report' => self::report($this->l($uid)->t('Change a collection'), [$name])];
	}

	private function setFields(string $uid, int $id, array $fields): array {
		$this->mustSee($uid, $id);
		$old = [];
		foreach ((array)($this->service->getCollection($uid, $id)['fields'] ?? []) as $f) {
			$old[(string)$f['key']] = $f;
		}
		$new = [];
		foreach (array_values($fields) as $i => $f) {
			if (!is_array($f)) {
				continue;
			}
			$key = (string)($f['key'] ?? '');
			if (isset($old[$key]) && (!empty($old[$key]['secret']) || in_array($old[$key]['type'], self::ATTACH, true))) {
				$new[] = $old[$key]; // a secret or attachment field stays exactly as it was
				continue;
			}
			$in = self::fieldIn($f, $i);
			$new[] = isset($old[$key]) ? array_merge($old[$key], $in, isset($in['options']) ? [] : ['options' => $old[$key]['options'] ?? null]) : $in;
		}
		$kept = array_flip(array_map(fn ($f) => (string)$f['key'], $new));
		foreach ($old as $k => $f) {
			if (!isset($kept[$k]) && (!empty($f['secret']) || in_array($f['type'], self::ATTACH, true))) {
				throw new \InvalidArgumentException('"' . $f['label'] . '" is a secret or attachment field: the assistant does not remove it. The person removes it in "🧩 Edit collection".');
			}
		}
		$c = $this->service->replaceFields($uid, $id, $new);
		return ['fields' => count($new), '_report' => self::report($this->l($uid)->t('Change the fields'), [(string)($c['name'] ?? '')]) . ' (' . count($new) . ')'];
	}

	private function deleteCollection(string $uid, int $id): array {
		$v = $this->mustSee($uid, $id);
		$this->service->deleteCollection($uid, $id);
		$this->setCategory($uid, $id, '');
		return ['deleted' => $id, '_report' => self::report($this->l($uid)->t('Delete a collection'), [(string)($v['name'] ?? '')])];
	}
}
