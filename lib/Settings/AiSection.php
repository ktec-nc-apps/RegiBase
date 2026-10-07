<?php

declare(strict_types=1);

namespace OCA\RegiBase\Settings;

use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\Settings\IIconSection;

/** "RegiBase" in the administration settings, for its AI assistant. */
class AiSection implements IIconSection {
	public function __construct(
		private IL10N $l,
		private IURLGenerator $url,
	) {
	}

	public function getID(): string {
		return 'regibase';
	}

	public function getName(): string {
		return $this->l->t('RegiBase');
	}

	public function getPriority(): int {
		return 80;
	}

	public function getIcon(): string {
		return $this->url->imagePath('regibase', 'app-dark.svg');
	}
}
