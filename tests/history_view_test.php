<?php
/**
 * The snapshot list says what each change did (owner, 2026-11-04), and never a value that
 * must not be shown:
 *
 *   - an edit: "field: old → new" per field; a secret field only as "secret field changed",
 *     its value (old or new, plain or encrypted) nowhere in the answer, not even to the owner;
 *     an attachment only as "image changed";
 *   - an addition: the title and a few fields; a deletion: the title; bulk changes: counts;
 *   - fields added / removed / renamed; collection settings changed (names only);
 *   - somebody the collection is shared with: no secret of the owner's, not from a new entry
 *     nor from one recorded before views were kept (whose undo data holds the full old record),
 *     no field the collection no longer has, and nothing at all once the share is taken away;
 *   - what is kept per change stays small; the list without ?detail=1 is as it was.
 *
 * Run: php tests/history_view_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/memdb.php';

function entries(World $w, string $uid, int $cid): array {
	return $w->svc->history($uid, $cid, true);
}
function firstOf(array $entries, string $op): ?array {
	foreach ($entries as $e) {
		if ($e['op'] === $op) {
			return $e;
		}
	}
	return null;
}

const FIELDS = [
	['key' => 'name', 'label' => 'Name', 'is_title' => true],
	['key' => 'tel', 'label' => 'Phone'],
	['key' => 'pw', 'label' => 'Password', 'secret' => true],
	['key' => 'pic', 'label' => 'Photo', 'type' => 'image'],
];

attempt('owner: edit, add, delete', function (): void {
	$w = world();
	$a = $w->coll('alice', 'People', FIELDS);
	$w->files->readable['alice|900'] = true;
	$rid = $w->record($a, ['name' => 'Tanaka', 'tel' => '090-1111', 'pw' => 'OldSecret1', 'pic' => '']);
	$w->svc->updateRecord('alice', $rid, ['name' => 'Tanaka', 'tel' => '090-2222', 'pw' => 'NewSecret2', 'pic' => '900']);
	$e = firstOf(entries($w, 'alice', $a), 'record.update');
	$d = $e['detail'] ?? [];
	$json = json_encode(entries($w, 'alice', $a), JSON_UNESCAPED_UNICODE);
	check('edit: kind', ($d['kind'] ?? '') === 'edit', json_encode($d));
	$byLabel = [];
	foreach ($d['changes'] ?? [] as $c) {
		$byLabel[$c['label']] = $c;
	}
	check('edit: phone old → new', ($byLabel['Phone']['old'] ?? '') === '090-1111' && ($byLabel['Phone']['new'] ?? '') === '090-2222', json_encode($d));
	check('edit: the secret field is named only', !empty($byLabel['Password']['secret']) && !isset($byLabel['Password']['old']) && !isset($byLabel['Password']['new']));
	check('edit: neither secret value anywhere in the list', !str_contains($json, 'OldSecret1') && !str_contains($json, 'NewSecret2'));
	check('edit: the photo only as "image changed"', ($byLabel['Photo']['attach'] ?? '') === 'image' && !isset($byLabel['Photo']['new']));
	check('edit: unchanged fields not listed', !isset($byLabel['Name']));

	$w->svc->createRecord('alice', $a, ['name' => 'Suzuki', 'tel' => '03-1234', 'pw' => 'AddSecret3']);
	$d = firstOf(entries($w, 'alice', $a), 'record.create')['detail'] ?? [];
	check('add: title', ($d['kind'] ?? '') === 'add' && ($d['title'] ?? '') === 'Suzuki', json_encode($d));
	check('add: a field shown', in_array(['label' => 'Phone', 'value' => '03-1234'], $d['fields'] ?? [], true), json_encode($d));
	check('add: no secret', !str_contains(json_encode(entries($w, 'alice', $a)), 'AddSecret3'));

	$w->svc->deleteRecord('alice', $rid);
	$d = firstOf(entries($w, 'alice', $a), 'record.delete')['detail'] ?? [];
	check('delete: title', ($d['kind'] ?? '') === 'delete' && ($d['titles'] ?? []) === ['Tanaka'], json_encode($d));
	check('delete: no secret', !str_contains(json_encode(entries($w, 'alice', $a)), 'NewSecret2'));
});

attempt('a secret title is never the title shown', function (): void {
	$w = world();
	$a = $w->coll('alice', 'Keys', [['key' => 'k', 'label' => 'Key', 'secret' => true, 'is_title' => true], ['key' => 'site', 'label' => 'Site']]);
	$w->svc->createRecord('alice', $a, ['k' => 'TopSecret9', 'site' => 'example.org']);
	$rid = array_key_last($w->recs->rows);
	$w->svc->deleteRecord('alice', $rid);
	$json = json_encode(entries($w, 'alice', $a));
	check('not in any entry', !str_contains($json, 'TopSecret9'));
	check('the next field stands in for the title', ($e = firstOf(entries($w, 'alice', $a), 'record.delete')) && (($e['detail']['titles'] ?? []) === ['example.org']), json_encode($e['detail'] ?? null));
});

attempt('somebody it is shared with', function (): void {
	$w = world();
	$a = $w->coll('alice', 'Logins', FIELDS);
	$rid = $w->record($a, ['name' => 'Bank', 'tel' => '1', 'pw' => 'AliceOnly7', 'old_key' => 'gone']);
	$w->share($a, 'alice', 'bob', 'edit');
	$w->svc->updateRecord('bob', $rid, ['name' => 'Bank', 'tel' => '2']);
	// an entry of bob's from before views were kept: its undo data holds the whole old record
	$w->history->record('bob', 'record.update', $a, 'Edited: Bank', ['kind' => 'set_data', 'id' => $rid,
		'data' => ['name' => 'Bank', 'tel' => '0', 'pw' => 'AliceOnly7', 'old_key' => 'LegacyForeign']]);
	$list = entries($w, 'bob', $a);
	$json = json_encode($list, JSON_UNESCAPED_UNICODE);
	check('no secret of the owner\'s in his list', !str_contains($json, 'AliceOnly7'), $json);
	check('no field the collection does not have', !str_contains($json, 'LegacyForeign') && !str_contains($json, 'old_key'));
	$legacy = $list[0]['detail'] ?? [];
	check('the old entry shows its old values (marked "before")', ($legacy['changes'][0]['label'] ?? '') === 'Phone'
		&& ($legacy['changes'][0]['old'] ?? '') === '0' && !empty($legacy['changes'][0]['before']), json_encode($legacy));
	$w->shares->rows = [];
	$gone = entries($w, 'bob', $a);
	check('share taken away: summaries only', array_filter(array_column($gone, 'detail')) === [], json_encode(array_column($gone, 'detail')));
});

attempt('bulk, fields, settings, size, compatibility', function (): void {
	$w = world();
	$a = $w->coll('alice', 'Bulk', FIELDS);
	$r1 = $w->record($a, ['name' => 'A', 'tel' => 'x-1']);
	$r2 = $w->record($a, ['name' => 'B', 'tel' => 'x-2']);
	$w->svc->bulkUpdateRecords('alice', $a, [['id' => $r1, 'data' => ['name' => 'A', 'tel' => 'y-1']], ['id' => $r2, 'data' => ['name' => 'B', 'tel' => 'y-2']]], 'g1');
	$eds = array_values(array_filter(entries($w, 'alice', $a), fn ($e) => $e['op'] === 'record.update'));
	check('replace: each record its old → new', count($eds) === 2 && ($eds[0]['detail']['changes'][0]['new'] ?? '') === 'y-2' && $eds[0]['grp'] === 'g1', json_encode(array_column($eds, 'detail')));

	$w->svc->bulkAddRecords('alice', $a, [['name' => 'C'], ['name' => 'D'], ['name' => 'E'], ['name' => 'F']]);
	$d = firstOf(entries($w, 'alice', $a), 'record.bulk_add')['detail'] ?? [];
	check('import: count and first titles', ($d['count'] ?? 0) === 4 && ($d['titles'] ?? []) === ['C', 'D', 'E'], json_encode($d));

	$w->svc->replaceFields('alice', $a, [
		['key' => 'name', 'label' => 'Full name', 'is_title' => true], ['key' => 'tel', 'label' => 'Phone'],
		['key' => 'pw', 'label' => 'Password', 'secret' => true], ['key' => 'mail', 'label' => 'Mail'],
	]);
	$d = firstOf(entries($w, 'alice', $a), 'fields.replace')['detail'] ?? [];
	check('fields: added, removed, renamed', ($d['added'] ?? []) === ['Mail'] && ($d['removed'] ?? []) === ['Photo'] && ($d['renamed'] ?? []) === [['Name', 'Full name']], json_encode($d));

	$w->svc->updateCollection('alice', $a, ['name' => 'Bulk 2', 'color' => '#fff', 'secret_pin' => '123456']);
	$d = firstOf(entries($w, 'alice', $a), 'collection.update')['detail'] ?? [];
	check('settings: what changed, the name with its values', ($d['settings'] ?? []) === ['name', 'color', 'secret'] && ($d['name'] ?? []) === ['Bulk', 'Bulk 2'], json_encode($d));
	check('settings: the key itself nowhere', !str_contains(json_encode(entries($w, 'alice', $a)), '123456'));

	$long = str_repeat('長い値', 50);
	$many = [];
	for ($i = 0; $i < 30; $i++) {
		$many[] = ['key' => 'f' . $i, 'label' => 'F' . $i];
	}
	$b = $w->coll('alice', 'Wide', $many);
	$old = $new = [];
	foreach ($many as $f) {
		$old[$f['key']] = $long . 'a';
		$new[$f['key']] = $long . 'b';
	}
	$rid = $w->record($b, $old);
	$w->svc->updateRecord('alice', $rid, $new);
	$h = end($w->hist->rows);
	$view = $w->history->decode($h)['view'] ?? [];
	check('kept per change: at most ' . OCA\RegiBase\Service\HistoryView::MAX_CHANGES . ' fields', count($view['c'] ?? []) === OCA\RegiBase\Service\HistoryView::MAX_CHANGES && ($view['n'] ?? 0) === 30);
	check('kept per change: values cut to ' . OCA\RegiBase\Service\HistoryView::CUT, mb_strlen($view['c'][0]['o'] ?? '') <= OCA\RegiBase\Service\HistoryView::CUT);
	check('kept per change: under 2 KB', strlen(json_encode($view, JSON_UNESCAPED_UNICODE)) < 2048, (string)strlen(json_encode($view, JSON_UNESCAPED_UNICODE)));
	$d = firstOf(entries($w, 'alice', $b), 'record.update')['detail'] ?? [];
	check('shown: five fields and "25 more"', count($d['changes'] ?? []) === 5 && ($d['more'] ?? 0) === 25, json_encode(['n' => count($d['changes'] ?? []), 'more' => $d['more'] ?? null]));

	$plain = $w->svc->history('alice', $b);
	check('without ?detail the list is as it was', !array_key_exists('detail', $plain[0]) && !array_key_exists('undo_data', $plain[0]));
});

finish();
