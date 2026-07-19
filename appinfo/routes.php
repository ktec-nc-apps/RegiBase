<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

		// templates
		['name' => 'api#templates', 'url' => '/api/templates', 'verb' => 'GET'],
		['name' => 'api#createTemplate', 'url' => '/api/templates', 'verb' => 'POST'],
		['name' => 'api#updateTemplate', 'url' => '/api/templates/{id}', 'verb' => 'PUT'],
		['name' => 'api#deleteTemplate', 'url' => '/api/templates/{id}', 'verb' => 'DELETE'],
		['name' => 'api#editBuiltinTemplate', 'url' => '/api/templates/builtin/{key}', 'verb' => 'POST'],
		['name' => 'api#resetBuiltinTemplate', 'url' => '/api/templates/builtin/{key}', 'verb' => 'DELETE'],
		['name' => 'api#getI18n', 'url' => '/api/i18n/{lang}', 'verb' => 'GET'],

		// collections
		['name' => 'api#collections', 'url' => '/api/collections', 'verb' => 'GET'],
		['name' => 'api#getCollection', 'url' => '/api/collections/{id}', 'verb' => 'GET'],
		['name' => 'api#createCollection', 'url' => '/api/collections', 'verb' => 'POST'],
		['name' => 'api#updateCollection', 'url' => '/api/collections/{id}', 'verb' => 'PATCH'],
		['name' => 'api#deleteCollection', 'url' => '/api/collections/{id}', 'verb' => 'DELETE'],
		['name' => 'api#duplicateCollection', 'url' => '/api/collections/{id}/duplicate', 'verb' => 'POST'],
		['name' => 'api#putFields', 'url' => '/api/collections/{id}/fields', 'verb' => 'PUT'],
		['name' => 'api#exportCollection', 'url' => '/api/collections/{id}/export', 'verb' => 'GET'],

		// internal sharing
		['name' => 'api#collectionShares', 'url' => '/api/collections/{id}/shares', 'verb' => 'GET'],
		['name' => 'api#addShare', 'url' => '/api/collections/{id}/shares', 'verb' => 'POST'],
		['name' => 'api#updateShare', 'url' => '/api/collections/{id}/shares/{uid}', 'verb' => 'PATCH'],
		['name' => 'api#removeShare', 'url' => '/api/collections/{id}/shares/{uid}', 'verb' => 'DELETE'],
		['name' => 'api#unlockShare', 'url' => '/api/collections/{id}/unlock', 'verb' => 'POST'],
		['name' => 'api#searchUsers', 'url' => '/api/users/search', 'verb' => 'GET'],

		// records
		['name' => 'api#records', 'url' => '/api/collections/{id}/records', 'verb' => 'GET'],
		['name' => 'api#reorderRecords', 'url' => '/api/collections/{id}/record-order', 'verb' => 'PUT'],
		['name' => 'api#createRecord', 'url' => '/api/collections/{id}/records', 'verb' => 'POST'],
		['name' => 'api#getRecord', 'url' => '/api/records/{id}', 'verb' => 'GET'],
		['name' => 'api#updateRecord', 'url' => '/api/records/{id}', 'verb' => 'PUT'],
		['name' => 'api#deleteRecord', 'url' => '/api/records/{id}', 'verb' => 'DELETE'],
		['name' => 'api#deleteRecords', 'url' => '/api/records/delete', 'verb' => 'POST'],

		// transfer (move/copy between collections)
		['name' => 'api#transfer', 'url' => '/api/transfer', 'verb' => 'POST'],

		// CSV import
		['name' => 'api#importAnalyze', 'url' => '/api/import/analyze', 'verb' => 'POST'],
		['name' => 'api#importCommit', 'url' => '/api/import/commit', 'verb' => 'POST'],

		// images
		['name' => 'api#uploadImage', 'url' => '/api/images', 'verb' => 'POST'],
		['name' => 'api#getImage', 'url' => '/api/images/{id}', 'verb' => 'GET'],

		// document / notes attachments
		['name' => 'api#uploadFile', 'url' => '/api/files', 'verb' => 'POST'],
		['name' => 'api#resolveFilePath', 'url' => '/api/files/resolve', 'verb' => 'POST'],
		['name' => 'api#browseFiles', 'url' => '/api/files/browse', 'verb' => 'GET'],
		['name' => 'api#fileMeta', 'url' => '/api/files/{id}/meta', 'verb' => 'GET'],
		['name' => 'api#getFile', 'url' => '/api/files/{id}', 'verb' => 'GET'],

		// settings
		['name' => 'api#getSettings', 'url' => '/api/settings', 'verb' => 'GET'],
		['name' => 'api#updateSettings', 'url' => '/api/settings', 'verb' => 'PUT'],
		['name' => 'api#backup', 'url' => '/api/backup', 'verb' => 'POST'],
		['name' => 'api#restore', 'url' => '/api/restore', 'verb' => 'POST'],
		['name' => 'api#contactsAddressbooks', 'url' => '/api/contacts/addressbooks', 'verb' => 'GET'],
		['name' => 'api#contactsImport', 'url' => '/api/contacts/import', 'verb' => 'POST'],

		// Tables integration
		['name' => 'api#tablesList', 'url' => '/api/tables/list', 'verb' => 'GET'],
		['name' => 'api#tablesImport', 'url' => '/api/tables/import', 'verb' => 'POST'],
		['name' => 'api#tablesExport', 'url' => '/api/collections/{id}/tables-export', 'verb' => 'POST'],
	],
];
