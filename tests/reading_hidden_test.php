<?php
/**
 * Regression test: a secret value does not reach somebody the collection is shared with
 * through the record's stored "reading" (review).
 *
 * The title field is secret and its value plain text (no master key): bob, given the
 * collection without its key, gets neither the value nor a reading made from it, from
 * the list or from one record. Alice, the owner, still gets the reading as stored.
 *
 * Run: php tests/reading_hidden_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/memdb.php';

attempt('reading of a secret title', function (): void {
	$w = world();
	$a = $w->coll('alice', 'Accounts', [['key' => 'pw', 'secret' => true, 'is_title' => true], ['key' => 'site']]);
	$rid = $w->record($a, ['pw' => 'Hunter2', 'site' => 'example'], 'hunter2');
	$w->share($a, 'alice', 'bob', 'view');

	$list = $w->svc->listRecords('bob', $a, null, null);
	$one = $w->svc->getRecord('bob', $rid);
	check('the value itself is hidden (as before)', !isset($list[0]['data']['pw']) && !isset($one['data']['pw']));
	check('the list does not carry it in reading', !str_contains(json_encode($list), 'hunter2'), (string)($list[0]['reading'] ?? ''));
	check('one record does not carry it in reading', !str_contains(json_encode($one), 'hunter2'), (string)($one['reading'] ?? ''));
	$own = $w->svc->getRecord('alice', $rid);
	check('the owner still gets the stored reading', ($own['reading'] ?? '') === 'hunter2', (string)($own['reading'] ?? ''));
});

finish();
