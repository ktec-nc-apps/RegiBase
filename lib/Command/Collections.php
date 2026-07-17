<?php

declare(strict_types=1);

namespace OCA\RegiBase\Command;

use OCA\RegiBase\Db\CollectionEntity;
use Symfony\Component\Console\Helper\Table;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class Collections extends Base {
	protected function configure(): void {
		$this->setName('regibase:collections')
			->setDescription('List RegiBase collections')
			->addUserOption();
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$user = $input->getOption('user');
		$list = (is_string($user) && $user !== '')
			? $this->collections->findAllForUser($user)
			: $this->collections->findAll();

		if (count($list) === 0) {
			$output->writeln('<comment>No collections.</comment>');
			return 0;
		}

		$table = new Table($output);
		$table->setHeaders(['ID', 'User', 'Name', 'Records', 'View']);
		foreach ($list as $c) {
			/** @var CollectionEntity $c */
			$table->addRow([
				$c->getId(),
				$c->getUserId(),
				$c->getIcon() . ' ' . $c->getName(),
				$this->records->countForCollection((int)$c->getId()),
				$c->getView(),
			]);
		}
		$table->render();
		return 0;
	}
}
