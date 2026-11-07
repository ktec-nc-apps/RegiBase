<?php
/**
 * Regression test: a collection its owner shared with a group the owner is in is not a
 * share to the owner (review).
 *
 *   - it is listed once, as the owner's;
 *   - hidden (secret), it is not listed and does not open until its 6-digit key is given;
 *   - the other members still get it through the group.
 *
 * Run: php tests/own_group_share_test.php
 */
declare(strict_types=1);
require __DIR__ . '/boot.php';
require __DIR__ . '/memdb.php';

attempt('owner in the group a collection is shared with', function (): void {
	$w = world();
	$w->groups = ['alice' => ['staff'], 'bob' => ['staff']];
	$open = $w->coll('alice', 'Open', [['key' => 'name', 'is_title' => true]]);
	$hidden = $w->coll('alice', 'Hidden', [['key' => 'name', 'is_title' => true]], ['Secret' => true, 'SecretHash' => password_hash('123456', PASSWORD_DEFAULT)]);
	$w->record($hidden, ['name' => 'private']);
	$w->share($open, 'alice', 'staff', 'view', 'group');
	$w->share($hidden, 'alice', 'staff', 'view', 'group');

	$ids = array_map(fn ($c) => (int)$c['id'], $w->svc->listCollections('alice'));
	check('the open one is listed once', count(array_keys($ids, $open, true)) === 1, json_encode($ids));
	check('the hidden one is not listed', !in_array($hidden, $ids, true), json_encode($ids));
	$opened = true;
	try {
		$w->svc->listRecords('alice', $hidden, null, null);
	} catch (\Throwable $e) {
		$opened = false;
	}
	check('the hidden one does not open without its key', !$opened);
	$bob = array_map(fn ($c) => (int)$c['id'], $w->svc->listCollections('bob'));
	check('another member still gets both', in_array($open, $bob, true) && in_array($hidden, $bob, true), json_encode($bob));
});

finish();
