<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCP\IL10N;

class Templates {
	/**
	 * Built-in collection templates. Names, descriptions, field labels and
	 * Japanese select-options are translated through IL10N (source language =
	 * Japanese; translations live in l10n/<lang>.json). Field 'key' values stay
	 * as stable English identifiers and are never translated.
	 * @return array<int,array>
	 */
	public static function all(IL10N $l): array {
		$t = static fn (string $s): string => $l->t($s);
		return [
			[
				'key' => 'credit_card', 'name' => $t('Credit card'), 'icon' => '💳', 'color' => '#6366f1',
				'description' => $t('Card number, expiry, security code, etc.'),
				'fields' => [
					['key' => 'card_name', 'label' => $t('Card name'), 'type' => 'text', 'is_title' => true, 'required' => true, 'placeholder' => $t('e.g. Rakuten Card')],
					['key' => 'brand', 'label' => $t('Brand'), 'type' => 'select', 'options' => ['Visa', 'Mastercard', 'JCB', 'American Express', 'Diners', $t('Other')]],
					['key' => 'number', 'label' => $t('Card number'), 'type' => 'text', 'secret' => true, 'placeholder' => '4111111111111111', 'options' => ['charset' => 'digits', 'max' => 19]],
					['key' => 'holder', 'label' => $t('Cardholder'), 'type' => 'text', 'options' => ['charset' => 'alpha', 'max' => 40]],
					['key' => 'expiry', 'label' => $t('Expiry'), 'type' => 'month'],
					['key' => 'cvc', 'label' => $t('Security code'), 'type' => 'text', 'secret' => true, 'options' => ['charset' => 'digits', 'min' => 3, 'max' => 4]],
					['key' => 'pin', 'label' => $t('PIN'), 'type' => 'password', 'secret' => true, 'options' => ['charset' => 'digits', 'min' => 4, 'max' => 6]],
					['key' => 'issuer', 'label' => $t('Card issuer'), 'type' => 'text'],
					['key' => 'support_tel', 'label' => $t('Support phone'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'memo', 'label' => $t('Memo'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'bank_account', 'name' => $t('Bank account'), 'icon' => '🏦', 'color' => '#059669',
				'description' => $t('Bank name, branch, account number, online banking'),
				'fields' => [
					['key' => 'bank_name', 'label' => $t('Bank name'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'branch', 'label' => $t('Branch name'), 'type' => 'text'],
					['key' => 'account_type', 'label' => $t('Type'), 'type' => 'select', 'options' => [$t('Ordinary'), $t('Checking'), $t('Savings'), $t('Other')]],
					['key' => 'account_number', 'label' => $t('Account number'), 'type' => 'text', 'options' => ['charset' => 'digits', 'max' => 10]],
					['key' => 'holder', 'label' => $t('Account holder'), 'type' => 'text'],
					['key' => 'login_id', 'label' => $t('Login ID'), 'type' => 'text'],
					['key' => 'login_password', 'label' => $t('Login password'), 'type' => 'password', 'secret' => true],
					['key' => 'pin', 'label' => $t('PIN'), 'type' => 'password', 'secret' => true, 'options' => ['charset' => 'digits', 'min' => 4, 'max' => 4]],
					['key' => 'memo', 'label' => $t('Memo'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'online_account', 'name' => $t('Online account'), 'icon' => '🔐', 'color' => '#2563eb',
				'description' => $t('Web service sign-ups (ID/password)'),
				'fields' => [
					['key' => 'service', 'label' => $t('Service name'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'url', 'label' => 'URL', 'type' => 'url', 'placeholder' => 'https://'],
					['key' => 'username', 'label' => $t('Username / ID'), 'type' => 'text'],
					['key' => 'email', 'label' => $t('Email address'), 'type' => 'email'],
					['key' => 'password', 'label' => $t('Password'), 'type' => 'password', 'secret' => true],
					['key' => 'otp', 'label' => $t('Two-factor auth / recovery codes'), 'type' => 'textarea', 'secret' => true],
					['key' => 'category', 'label' => $t('Category'), 'type' => 'text'],
					['key' => 'memo', 'label' => $t('Memo'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'membership_id', 'name' => $t('Membership / ID'), 'icon' => '🪪', 'color' => '#d97706',
				'description' => $t('Membership number, various IDs, certificate numbers'),
				'fields' => [
					['key' => 'name', 'label' => $t('Name'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'number', 'label' => $t('Number'), 'type' => 'text', 'secret' => true],
					['key' => 'holder', 'label' => $t('Cardholder'), 'type' => 'text'],
					['key' => 'issued', 'label' => $t('Issue date'), 'type' => 'date'],
					['key' => 'expiry', 'label' => $t('Expiry'), 'type' => 'date'],
					['key' => 'memo', 'label' => $t('Memo'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'software_license', 'name' => $t('License management'), 'icon' => '🔑', 'color' => '#7c3aed',
				'description' => $t('Software license keys and purchase info'),
				'fields' => [
					['key' => 'product', 'label' => $t('Product name'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'version', 'label' => $t('Version'), 'type' => 'text'],
					['key' => 'license_key', 'label' => $t('License key'), 'type' => 'text', 'secret' => true],
					['key' => 'email', 'label' => $t('Registered email'), 'type' => 'email'],
					['key' => 'purchased', 'label' => $t('Purchase date'), 'type' => 'date'],
					['key' => 'url', 'label' => $t('Download URL'), 'type' => 'url'],
					['key' => 'memo', 'label' => $t('Memo'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'contact_personal', 'name' => $t('Contacts (personal)'), 'icon' => '👤', 'color' => '#0ea5e9',
				'description' => $t('Personal contacts such as friends (with photo)'),
				'fields' => [
					['key' => 'name', 'label' => $t('Full name'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'reading', 'label' => $t('Reading (furigana)'), 'type' => 'text'],
					['key' => 'photo', 'label' => $t('Photo'), 'type' => 'image_crop', 'options' => ['ratio' => '1:1', 'out' => 600]],
					['key' => 'nickname', 'label' => $t('Nickname'), 'type' => 'text'],
					['key' => 'mobile', 'label' => $t('Mobile phone'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'phone', 'label' => $t('Phone (home)'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'email', 'label' => $t('Email'), 'type' => 'email'],
					['key' => 'sns', 'label' => 'LINE / SNS', 'type' => 'text'],
					['key' => 'birthday', 'label' => $t('Birthday'), 'type' => 'date'],
					['key' => 'address', 'label' => $t('Address'), 'type' => 'textarea'],
					['key' => 'relation', 'label' => $t('Relationship'), 'type' => 'select', 'options' => [$t('Family'), $t('Friend'), $t('Acquaintance'), $t('Work'), $t('Other')]],
					['key' => 'memo', 'label' => $t('Memo'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'contact_customer', 'name' => $t('Contacts (customer)'), 'icon' => '💼', 'color' => '#0d9488',
				'description' => $t('Business/customer contacts (company, rep, category)'),
				'fields' => [
					['key' => 'company', 'label' => $t('Company name'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'company_reading', 'label' => $t('Reading (company)'), 'type' => 'text'],
					['key' => 'logo', 'label' => $t('Company logo'), 'type' => 'image', 'options' => ['max' => 400]],
					['key' => 'contact_name', 'label' => $t('Contact name'), 'type' => 'text'],
					['key' => 'department', 'label' => $t('Department'), 'type' => 'text'],
					['key' => 'position', 'label' => $t('Position'), 'type' => 'text'],
					['key' => 'phone', 'label' => $t('Phone'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'mobile', 'label' => $t('Mobile'), 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'fax', 'label' => 'FAX', 'type' => 'tel', 'options' => ['charset' => 'phone', 'max' => 20]],
					['key' => 'email', 'label' => $t('Email'), 'type' => 'email'],
					['key' => 'url', 'label' => $t('Website'), 'type' => 'url', 'placeholder' => 'https://'],
					['key' => 'postal', 'label' => $t('Postal code'), 'type' => 'text', 'options' => ['charset' => 'custom', 'pattern' => '\\d{3}-?\\d{4}']],
					['key' => 'address', 'label' => $t('Address'), 'type' => 'textarea'],
					['key' => 'customer_id', 'label' => $t('Customer number'), 'type' => 'text'],
					['key' => 'category', 'label' => $t('Classification'), 'type' => 'select', 'options' => [$t('Prospect'), $t('Active'), $t('Dormant'), $t('Other')]],
					['key' => 'last_contact', 'label' => $t('Last contact date'), 'type' => 'date'],
					['key' => 'memo', 'label' => $t('Memo'), 'type' => 'textarea'],
				],
			],
			[
				'key' => 'blank', 'name' => $t('Empty collection'), 'icon' => '📁', 'color' => '#64748b',
				'description' => $t('Design the fields yourself from scratch'),
				'fields' => [
					['key' => 'title', 'label' => $t('Title'), 'type' => 'text', 'is_title' => true, 'required' => true],
					['key' => 'memo', 'label' => $t('Memo'), 'type' => 'textarea'],
				],
			],
		];
	}

	public static function byKey(IL10N $l, string $key): ?array {
		foreach (self::all($l) as $t) {
			if ($t['key'] === $key) {
				return $t;
			}
		}
		return null;
	}
}
