<?php

declare(strict_types=1);

namespace OCA\RegiBase\Settings;

use OCA\RegiBase\Service\AiService;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IGroupManager;
use OCP\Settings\ISettings;
use OCP\Util;

/**
 * The AI assistant's settings: on or off, who may use it, what it may read and
 * whether it may search the web. Without AI-Hub it is all shown greyed out.
 */
class AiAdmin implements ISettings {
	public function __construct(
		private AiService $ai,
		private IGroupManager $groups,
	) {
	}

	public function getForm(): TemplateResponse {
		Util::addScript('regibase', 'admin-ai');
		Util::addStyle('regibase', 'admin-ai');
		$groups = [];
		foreach ($this->groups->search('') as $g) {
			$groups[] = ['id' => $g->getGID(), 'name' => $g->getDisplayName()];
		}
		return new TemplateResponse('regibase', 'admin-ai', [
			'hub' => $this->ai->hubStatus(),
			'settings' => $this->ai->settings(),
			'groups' => $groups,
		], '');
	}

	public function getSection(): string {
		return 'regibase';
	}

	public function getPriority(): int {
		return 10;
	}
}
